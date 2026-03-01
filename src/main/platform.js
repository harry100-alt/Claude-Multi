/**
 * Platform-specific helpers for operations that differ across Win/Mac/Linux.
 */
const { execSync, exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

const IS_WIN = process.platform === 'win32';

/**
 * Create a directory junction (Windows) or symlink (Mac/Linux).
 */
function makeLink(linkPath, targetPath) {
  if (!fs.existsSync(targetPath)) return false;

  // Remove existing link/dir at target
  try {
    fs.lstatSync(linkPath); // Throws if not present at all
    if (IS_WIN) {
      execSync(`cmd /c rmdir "${linkPath}"`, { windowsHide: true, stdio: 'ignore' });
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch {}

  // Still exists? Force remove
  if (fs.existsSync(linkPath)) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  if (IS_WIN) {
    execSync(`cmd /c mklink /J "${linkPath}" "${targetPath}"`, { windowsHide: true, stdio: 'pipe' });
    return true;
  } else {
    fs.symlinkSync(targetPath, linkPath, 'dir');
    return true;
  }
}

/**
 * Create a file symlink.
 */
function makeFileLink(linkPath, targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  try {
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    fs.symlinkSync(targetPath, linkPath, 'file');
    return true;
  } catch {
    // Fallback: copy
    try {
      fs.copyFileSync(targetPath, linkPath);
      return true;
    } catch { return false; }
  }
}

/**
 * Kill a process tree by PID. No orphans.
 */
function killProcessTree(pid) {
  try {
    if (IS_WIN) {
      execSync(`taskkill /T /F /PID ${pid}`, { windowsHide: true, stdio: 'ignore' });
    } else {
      // Kill process group
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      // Give it 2s then force
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      }, 2000);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get running Claude processes.
 * Returns [{ pid, commandLine, userDataDir, isMainProcess }]
 */
function getClaudeProcesses() {
  try {
    if (IS_WIN) {
      return getClaudeProcessesWindows();
    } else {
      return getClaudeProcessesUnix();
    }
  } catch {
    return [];
  }
}

function getClaudeProcessesWindows() {
  const out = execSync(
    "wmic process where \"name='claude.exe'\" get ProcessId,CommandLine,ExecutablePath /format:list",
    { encoding: 'utf-8', windowsHide: true, timeout: 10000 }
  );

  const entries = parseWmicOutput(out);
  return entries
    .filter(fields => {
      // Skip Claude Code CLI processes (they live under AppData, not WindowsApps/mirror)
      const exe = (fields.ExecutablePath || '').toLowerCase();
      return exe.includes('windowsapps') || exe.includes('claude-multi');
    })
    .map(fields => {
      const cmd = fields.CommandLine || '';
      const pid = parseInt(fields.ProcessId || '0', 10);
      let userDataDir = null;
      if (cmd.includes('--user-data-dir=')) {
        // Handle both quoted and unquoted: --user-data-dir="C:\..." or --user-data-dir=C:\...
        const after = cmd.split('--user-data-dir=')[1];
        if (after.startsWith('"')) {
          userDataDir = after.substring(1).split('"')[0];
        } else {
          userDataDir = after.split(' ')[0];
        }
      }
      return {
        pid,
        commandLine: cmd,
        userDataDir,
        isMainProcess: !cmd.includes('--type=')
      };
    });
}

function getClaudeProcessesUnix() {
  const out = execSync(
    "ps aux | grep -i '[C]laude' || true",
    { encoding: 'utf-8', timeout: 5000 }
  ).trim();

  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[1], 10);
    const cmd = parts.slice(10).join(' ');
    let userDataDir = null;
    if (cmd.includes('--user-data-dir=')) {
      userDataDir = cmd.split('--user-data-dir=')[1].split(' ')[0];
    }
    return {
      pid,
      commandLine: cmd,
      userDataDir,
      isMainProcess: !cmd.includes('--type=')
    };
  });
}

/**
 * Get memory for ALL Claude processes in a single async call.
 * Returns { pid: memoryMB, ... }
 * Uses tasklist (~100ms, non-blocking) instead of PowerShell per-process (~500ms each, blocking).
 */
async function getClaudeMemoryMap() {
  try {
    if (IS_WIN) {
      const { stdout } = await execAsync(
        'tasklist /FI "IMAGENAME eq Claude.exe" /FO CSV /NH',
        { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
      );
      const map = {};
      for (const line of stdout.trim().split('\n')) {
        // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
        const match = line.match(/"[^"]*","(\d+)","[^"]*","[^"]*","([\d,]+)\s*K"/);
        if (match) {
          map[parseInt(match[1], 10)] = Math.round(parseInt(match[2].replace(/,/g, ''), 10) / 1024);
        }
      }
      return map;
    } else {
      const { stdout } = await execAsync(
        "ps -eo pid,rss,comm | grep -i '[C]laude' || true",
        { encoding: 'utf-8', timeout: 5000 }
      );
      const map = {};
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        map[parseInt(parts[0], 10)] = Math.round(parseInt(parts[1], 10) / 1024);
      }
      return map;
    }
  } catch {
    return {};
  }
}

function parseWmicOutput(raw) {
  const normalized = raw.replace(/\r\r\n/g, '\n').replace(/\r\n/g, '\n');
  return normalized.split('\n\n')
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const fields = {};
      for (const line of block.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
          fields[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
        }
      }
      return fields;
    })
    .filter(f => Object.keys(f).length > 0);
}

/**
 * Spawn a detached process.
 */
function spawnDetached(exe, args, cwd) {
  const opts = {
    detached: true,
    stdio: 'ignore',
    cwd
  };
  if (IS_WIN) {
    opts.windowsHide = false;
  }
  const child = spawn(exe, args, opts);
  child.unref();
  return child.pid;
}

module.exports = {
  IS_WIN,
  makeLink,
  makeFileLink,
  killProcessTree,
  getClaudeProcesses,
  getClaudeMemoryMap,
  spawnDetached
};
