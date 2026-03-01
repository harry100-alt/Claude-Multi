const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let cachedClaudePath = null;

/**
 * Find Claude Desktop's executable path.
 * Returns { exe, appDir, resourcesDir } or null.
 */
function findClaude() {
  if (cachedClaudePath && fs.existsSync(cachedClaudePath.exe)) {
    return cachedClaudePath;
  }

  const finder = process.platform === 'win32' ? findClaudeWindows
    : process.platform === 'darwin' ? findClaudeMac
    : findClaudeLinux;

  cachedClaudePath = finder();
  return cachedClaudePath;
}

function findClaudeWindows() {
  // Try Get-AppxPackage first
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-AppxPackage -Name \'Claude\').InstallLocation"',
      { encoding: 'utf-8', windowsHide: true, timeout: 10000 }
    ).trim();
    if (out) {
      const exe = path.join(out, 'app', 'Claude.exe');
      if (fs.existsSync(exe)) {
        return makeResult(exe);
      }
    }
  } catch {}

  // Fallback: glob WindowsApps
  try {
    const base = 'C:\\Program Files\\WindowsApps';
    const dirs = fs.readdirSync(base)
      .filter(d => d.startsWith('Claude_'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const exe = path.join(base, d, 'app', 'Claude.exe');
      if (fs.existsSync(exe)) {
        return makeResult(exe);
      }
    }
  } catch {}

  return null;
}

function findClaudeMac() {
  const candidates = [
    '/Applications/Claude.app/Contents/MacOS/Claude',
    path.join(os.homedir(), 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude')
  ];
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      const appDir = path.resolve(exe, '..', '..');
      return {
        exe,
        appDir,
        resourcesDir: path.join(appDir, 'Resources')
      };
    }
  }
  return null;
}

function findClaudeLinux() {
  const candidates = [
    '/usr/bin/claude',
    '/opt/Claude/claude',
    path.join(os.homedir(), '.local', 'share', 'Claude', 'claude'),
    '/usr/lib/claude/claude',
    '/snap/claude/current/claude'
  ];
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      return makeResult(exe);
    }
  }

  // Try which
  try {
    const out = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (out && fs.existsSync(out)) {
      return makeResult(out);
    }
  } catch {}

  return null;
}

function makeResult(exe) {
  const appDir = path.dirname(exe);
  return {
    exe,
    appDir,
    resourcesDir: path.join(appDir, 'resources')
  };
}

/**
 * Get Claude's version string from the install path.
 * On Windows, parses it from the WindowsApps folder name.
 */
function getClaudeVersion() {
  const claude = findClaude();
  if (!claude) return null;

  if (process.platform === 'win32') {
    // Path like: C:\Program Files\WindowsApps\Claude_1.1.4498.0_x64__pzs8sxrjxfjjc\app\Claude.exe
    const match = claude.appDir.match(/Claude_([\d.]+)_/);
    if (match) return match[1];
  }

  // Fallback: try reading package.json in resources
  try {
    const pkg = path.join(claude.resourcesDir, 'app.asar');
    // Can't easily read version from asar without extracting — return mtime as proxy
    const stat = fs.statSync(pkg);
    return stat.mtimeMs.toString();
  } catch {}

  return null;
}

module.exports = { findClaude, getClaudeVersion };
