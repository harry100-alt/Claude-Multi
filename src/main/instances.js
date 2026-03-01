const fs = require('fs');
const path = require('path');
const {
  INSTANCES_DIR, MIRROR_DIR, PRIMARY_CLAUDE_DIR,
  loadConfig, saveConfig, ensureDir
} = require('./config');
const { findClaude } = require('./claude-finder');
const { ensureMirror } = require('./mirror');
const { makeLink, makeFileLink, killProcessTree, getClaudeProcesses, getClaudeMemoryMap, spawnDetached } = require('./platform');

// In-memory tracking of launched instances
const runningPids = new Map(); // instanceId -> { pid, launchedAt }

// ─── Auth & shared data to copy/junction ──────────────────────────────────

const AUTH_FILES = ['Cookies', 'Cookies-journal'];
const CONFIG_FILES = ['config.json', 'Preferences', 'Local State'];
const AUTH_DIRS = ['Local Storage', 'Session Storage', 'IndexedDB'];
const SHARED_DIRS = [
  'claude-code-sessions',
  'local-agent-mode-sessions',
  'claude-code',
  'claude-code-vm',
  'vm_bundles',
  'Claude Extensions',
  'Claude Extensions Settings'
];

// ─── Instance profile setup ───────────────────────────────────────────────

function setupInstanceProfile(instanceId) {
  const instanceDir = path.join(INSTANCES_DIR, `instance-${instanceId}`);
  ensureDir(instanceDir);

  // Copy cookies (auth)
  const networkDir = path.join(instanceDir, 'Network');
  ensureDir(networkDir);
  const primaryNetwork = path.join(PRIMARY_CLAUDE_DIR, 'Network');

  if (fs.existsSync(primaryNetwork)) {
    for (const fname of AUTH_FILES) {
      const src = path.join(primaryNetwork, fname);
      const dst = path.join(networkDir, fname);
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }
  }

  // Copy config files
  for (const fname of CONFIG_FILES) {
    const src = path.join(PRIMARY_CLAUDE_DIR, fname);
    const dst = path.join(instanceDir, fname);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.copyFileSync(src, dst); } catch {}
    }
  }

  // Copy auth directories
  for (const dirName of AUTH_DIRS) {
    const src = path.join(PRIMARY_CLAUDE_DIR, dirName);
    const dst = path.join(instanceDir, dirName);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.cpSync(src, dst, { recursive: true }); } catch {}
    }
  }

  // Junction shared CCD dirs
  for (const dirName of SHARED_DIRS) {
    const src = path.join(PRIMARY_CLAUDE_DIR, dirName);
    const dst = path.join(instanceDir, dirName);
    if (fs.existsSync(src)) {
      makeLink(dst, src);
    }
  }

  // Symlink MCP config
  const cfgSrc = path.join(PRIMARY_CLAUDE_DIR, 'claude_desktop_config.json');
  const cfgDst = path.join(instanceDir, 'claude_desktop_config.json');
  if (fs.existsSync(cfgSrc) && !fs.existsSync(cfgDst)) {
    makeFileLink(cfgDst, cfgSrc);
  }

  return instanceDir;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────

function createInstance(name) {
  const config = loadConfig();

  // Find next available ID
  const existingIds = new Set(config.instances.map(i => i.id));
  let id = 1;
  while (existingIds.has(id)) id++;

  const instance = {
    id,
    name: name || `Instance ${id}`,
    favourite: false,
    autoLaunch: false,
    favouriteOrder: config.instances.length,
    createdAt: new Date().toISOString()
  };

  // Setup profile directory
  setupInstanceProfile(id);

  config.instances.push(instance);
  saveConfig(config);

  return instance;
}

async function deleteInstance(id) {
  // Remove from config FIRST (instant, unblocks UI via polling)
  const config = loadConfig();
  config.instances = config.instances.filter(i => i.id !== id);
  saveConfig(config);

  // Heavy cleanup in background — stop process, remove dirs
  setImmediate(async () => {
    try {
      stopInstance(id);
    } catch {}

    const instanceDir = path.join(INSTANCES_DIR, `instance-${id}`);
    if (fs.existsSync(instanceDir)) {
      // Remove junctions/symlinks before recursive delete
      // CRITICAL: must remove these first or rmSync could follow them into primary Claude data
      const { exec } = require('child_process');
      const execPromise = (cmd) => new Promise(resolve => {
        exec(cmd, { windowsHide: true }, () => resolve());
      });

      for (const dirName of SHARED_DIRS) {
        const dst = path.join(instanceDir, dirName);
        try {
          if (process.platform === 'win32') {
            await execPromise(`cmd /c rmdir "${dst}"`);
          } else {
            fs.unlinkSync(dst);
          }
        } catch {}
        // Safety: if junction still exists, do NOT let rmSync follow it
        if (fs.existsSync(dst)) {
          try { fs.unlinkSync(dst); } catch {}
        }
      }
      // Remove file symlink for MCP config
      const cfgLink = path.join(instanceDir, 'claude_desktop_config.json');
      try {
        const stat = fs.lstatSync(cfgLink);
        if (stat.isSymbolicLink()) fs.unlinkSync(cfgLink);
      } catch {}
      try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch {}
    }
  });
}

function renameInstance(id, newName) {
  const config = loadConfig();
  const inst = config.instances.find(i => i.id === id);
  if (inst) {
    inst.name = newName;
    saveConfig(config);
  }
}

function toggleFavourite(id) {
  const config = loadConfig();
  const inst = config.instances.find(i => i.id === id);
  if (inst) {
    inst.favourite = !inst.favourite;
    saveConfig(config);
  }
  return inst?.favourite;
}

function toggleAutoLaunch(id) {
  const config = loadConfig();
  const inst = config.instances.find(i => i.id === id);
  if (inst) {
    inst.autoLaunch = !inst.autoLaunch;
    saveConfig(config);
  }
  return inst?.autoLaunch;
}

function reorderFavourites(orderedIds) {
  const config = loadConfig();
  for (let i = 0; i < orderedIds.length; i++) {
    const inst = config.instances.find(x => x.id === orderedIds[i]);
    if (inst) inst.favouriteOrder = i;
  }
  saveConfig(config);
}

// ─── Launch / Stop ────────────────────────────────────────────────────────

async function launchInstance(id) {
  // Ensure mirror is ready
  const mirrorResult = await ensureMirror();
  if (!mirrorResult.ok) return mirrorResult;

  const claude = findClaude();
  if (!claude) return { ok: false, error: 'Claude not found' };

  const instanceDir = path.join(INSTANCES_DIR, `instance-${id}`);

  // Setup profile if it doesn't exist yet
  if (!fs.existsSync(instanceDir)) {
    setupInstanceProfile(id);
  }

  // Refresh cookies from primary profile
  refreshAuth(id);

  const mirrorExe = path.join(MIRROR_DIR, path.basename(claude.exe));
  const pid = spawnDetached(mirrorExe, [`--user-data-dir=${instanceDir}`], MIRROR_DIR);

  runningPids.set(id, { pid, launchedAt: Date.now() });

  return { ok: true, pid };
}

function stopInstance(id) {
  // Kill tracked PID first (instant)
  const tracking = runningPids.get(id);
  if (tracking) {
    killProcessTree(tracking.pid);
    runningPids.delete(id);
  }

  // Always scan for remaining processes with our user-data-dir
  // Claude can re-parent or spawn processes outside the original tree
  const instanceDir = path.join(INSTANCES_DIR, `instance-${id}`);
  try {
    const processes = getClaudeProcesses();
    for (const proc of processes) {
      if (proc.userDataDir && path.resolve(proc.userDataDir) === path.resolve(instanceDir)) {
        killProcessTree(proc.pid);
      }
    }
  } catch {}

  return { ok: true };
}

async function launchAll() {
  const config = loadConfig();
  const results = [];
  for (const inst of config.instances) {
    const status = getInstanceStatus(inst.id);
    if (status.status === 'stopped') {
      results.push({ id: inst.id, ...(await launchInstance(inst.id)) });
    }
  }
  return results;
}

function stopAll() {
  const config = loadConfig();
  const results = [];
  for (const inst of config.instances) {
    const status = getInstanceStatus(inst.id);
    if (status.status === 'running') {
      results.push({ id: inst.id, ...stopInstance(inst.id) });
    }
  }
  return results;
}

// ─── Status ───────────────────────────────────────────────────────────────

function refreshAuth(id) {
  // Re-copy cookies from primary so instance stays authenticated
  const instanceDir = path.join(INSTANCES_DIR, `instance-${id}`);
  const networkDir = path.join(instanceDir, 'Network');
  const primaryNetwork = path.join(PRIMARY_CLAUDE_DIR, 'Network');

  if (fs.existsSync(primaryNetwork)) {
    ensureDir(networkDir);
    for (const fname of AUTH_FILES) {
      const src = path.join(primaryNetwork, fname);
      const dst = path.join(networkDir, fname);
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }
  }
}

/**
 * Fast status check — only uses process.kill(pid, 0) which is instant.
 * No subprocess calls. Used by launchAll/stopAll/autoLaunch.
 */
function getInstanceStatus(id) {
  const tracking = runningPids.get(id);
  if (tracking) {
    try {
      process.kill(tracking.pid, 0);
      return { status: 'running', pid: tracking.pid, launchedAt: tracking.launchedAt };
    } catch (err) {
      if (err.code === 'EPERM') {
        return { status: 'running', pid: tracking.pid, launchedAt: tracking.launchedAt };
      }
      runningPids.delete(id);
    }
  }
  return { status: 'stopped' };
}

/**
 * Get all instances with status. Optimized for the 2s polling loop:
 * - PID alive check via process.kill(pid, 0) — instant, no subprocess
 * - Memory via single async tasklist call — ~100ms, non-blocking, only if something is running
 * - NO wmic (was 1-3s), NO PowerShell (was ~500ms per instance)
 */
async function getAllInstances() {
  const config = loadConfig();

  // Pass 1: fast PID alive checks (zero subprocess calls)
  let anyRunning = false;
  const results = [];

  for (const inst of config.instances) {
    const tracking = runningPids.get(inst.id);
    if (tracking) {
      let alive = false;
      try {
        process.kill(tracking.pid, 0);
        alive = true;
      } catch (err) {
        if (err.code === 'EPERM') alive = true;
        else runningPids.delete(inst.id);
      }
      if (alive) {
        anyRunning = true;
        results.push({ inst, status: 'running', pid: tracking.pid, launchedAt: tracking.launchedAt });
        continue;
      }
    }
    results.push({ inst, status: 'stopped' });
  }

  // Pass 2: single async tasklist for memory (only if anything is running, non-blocking)
  const memoryMap = anyRunning ? await getClaudeMemoryMap() : {};

  return results.map(({ inst, status, pid, launchedAt }) => {
    const uptime = launchedAt ? formatUptime(Date.now() - launchedAt) : null;
    return {
      ...inst,
      status,
      pid: pid || undefined,
      launchedAt: launchedAt || undefined,
      memoryMB: status === 'running' ? (memoryMap[pid] || 0) : undefined,
      uptime
    };
  });
}

function formatUptime(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

// Auto-launch instances flagged with autoLaunch
async function autoLaunchInstances() {
  const config = loadConfig();
  for (const inst of config.instances) {
    if (inst.autoLaunch) {
      const status = getInstanceStatus(inst.id);
      if (status.status === 'stopped') {
        await launchInstance(inst.id);
      }
    }
  }
}

/**
 * Reconcile config with filesystem and running processes on startup.
 * - Adds instance dirs found on disk but missing from config
 * - Populates runningPids for any instances already running
 * - Ignores primary Claude (no --user-data-dir or not in our instances dir)
 */
function reconcileInstances() {
  const config = loadConfig();
  const existingIds = new Set(config.instances.map(i => i.id));
  let changed = false;

  // Scan instances directory for dirs not in config
  if (fs.existsSync(INSTANCES_DIR)) {
    for (const entry of fs.readdirSync(INSTANCES_DIR)) {
      const match = entry.match(/^instance-(\d+)$/);
      if (!match) continue;
      const id = parseInt(match[1], 10);
      if (existingIds.has(id)) continue;

      config.instances.push({
        id,
        name: `Instance ${id}`,
        favourite: false,
        autoLaunch: false,
        favouriteOrder: config.instances.length,
        createdAt: new Date().toISOString()
      });
      existingIds.add(id);
      changed = true;
    }
  }

  if (changed) saveConfig(config);

  // Single process scan to populate runningPids for already-running instances
  try {
    const processes = getClaudeProcesses();
    for (const proc of processes) {
      if (!proc.isMainProcess || !proc.userDataDir) continue;

      // Only match our managed instances, not primary Claude
      const resolved = path.resolve(proc.userDataDir);
      if (!resolved.startsWith(path.resolve(INSTANCES_DIR))) continue;

      const dirMatch = resolved.match(/instance-(\d+)/);
      if (!dirMatch) continue;

      const id = parseInt(dirMatch[1], 10);
      if (existingIds.has(id) && !runningPids.has(id)) {
        runningPids.set(id, { pid: proc.pid, launchedAt: Date.now() });
      }
    }
  } catch {}
}

module.exports = {
  createInstance,
  deleteInstance,
  renameInstance,
  toggleFavourite,
  toggleAutoLaunch,
  reorderFavourites,
  launchInstance,
  stopInstance,
  launchAll,
  stopAll,
  getAllInstances,
  autoLaunchInstances,
  reconcileInstances
};
