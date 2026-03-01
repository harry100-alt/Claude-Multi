const fs = require('fs');
const path = require('path');
const os = require('os');

function getAppDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Claude-Multi');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Claude-Multi');
    default:
      return path.join(os.homedir(), '.config', 'claude-multi');
  }
}

function getPrimaryClaudeDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Claude');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
    default:
      return path.join(os.homedir(), '.config', 'Claude');
  }
}

const APP_DATA_DIR = getAppDataDir();
const MIRROR_DIR = path.join(APP_DATA_DIR, 'app');
const INSTANCES_DIR = path.join(APP_DATA_DIR, 'instances');
const CONFIG_FILE = path.join(APP_DATA_DIR, 'config.json');
const PRIMARY_CLAUDE_DIR = getPrimaryClaudeDir();
const CCD_SESSIONS_DIR = path.join(PRIMARY_CLAUDE_DIR, 'claude-code-sessions');

const DEFAULT_CONFIG = {
  instances: [],
  theme: 'dark',
  version: 1,
  windowBounds: null,
  patchedClaudeVersion: null
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  ensureDir(APP_DATA_DIR);
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  ensureDir(APP_DATA_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

module.exports = {
  APP_DATA_DIR,
  MIRROR_DIR,
  INSTANCES_DIR,
  CONFIG_FILE,
  PRIMARY_CLAUDE_DIR,
  CCD_SESSIONS_DIR,
  loadConfig,
  saveConfig,
  ensureDir
};
