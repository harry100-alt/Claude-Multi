const { app, BrowserWindow } = require('electron');
const path = require('path');
const { setupIpcHandlers } = require('./ipc-handlers');
const { setupTray } = require('./tray');
const { loadConfig, saveConfig } = require('./config');

let mainWindow = null;

function createWindow() {
  const config = loadConfig();
  const bounds = config.windowBounds || { width: 720, height: 600 };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 520,
    minHeight: 400,
    frame: false,
    icon: path.join(__dirname, 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: config.theme === 'light' ? '#f5f4ef' : '#2b2b28',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      const cfg = loadConfig();
      cfg.windowBounds = mainWindow.getBounds();
      saveConfig(cfg);
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  return mainWindow;
}

app.whenReady().then(() => {
  mainWindow = createWindow();
  setupIpcHandlers(mainWindow);
  setupTray(mainWindow);
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  // Don't quit — stay in tray
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});
