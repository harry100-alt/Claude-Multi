const { Tray, BrowserWindow, nativeImage, app, screen, ipcMain } = require('electron');
const path = require('path');
const { getAllInstances, launchAll, stopAll, launchInstance, stopInstance } = require('./instances');
const { loadConfig } = require('./config');

let tray = null;
let trayWin = null;
let mainWindow = null;
let lastBounds = null;

function setupTray(win) {
  mainWindow = win;

  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Claude Multi');

  tray.on('click', (_, bounds) => {
    toggleTrayMenu(bounds);
  });

  tray.on('right-click', (_, bounds) => {
    toggleTrayMenu(bounds);
  });

  // Handle actions from tray menu
  ipcMain.on('tray-action', (_, { action, id }) => {
    if (trayWin) trayWin.hide();

    switch (action) {
      case 'launch':
        if (id !== null) launchInstance(id).catch(() => {});
        break;
      case 'stop':
        if (id !== null) stopInstance(id);
        break;
      case 'launch-all':
        launchAll().catch(() => {});
        break;
      case 'close-all':
        stopAll();
        break;
      case 'open':
        if (mainWindow) mainWindow.show();
        break;
      case 'quit':
        app.isQuitting = true;
        app.quit();
        break;
    }
  });

  // Handle resize from tray HTML (content-aware height)
  ipcMain.on('tray-resize', (_, height) => {
    if (trayWin && lastBounds) {
      const popupWidth = 210;
      trayWin.setSize(popupWidth, height);
      positionTrayWin(lastBounds, popupWidth, height);
    }
  });
}

function toggleTrayMenu(bounds) {
  if (trayWin && trayWin.isVisible()) {
    trayWin.hide();
    return;
  }
  showTrayMenu(bounds);
}

async function showTrayMenu(trayBounds) {
  lastBounds = trayBounds;
  const instances = await getAllInstances();
  const config = loadConfig();
  const popupWidth = 210;
  const popupHeight = 300; // initial, resized by content

  if (!trayWin) {
    trayWin = new BrowserWindow({
      width: popupWidth,
      height: popupHeight,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      hasShadow: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    trayWin.loadFile(path.join(__dirname, '..', 'renderer', 'tray.html'));

    trayWin.on('blur', () => {
      if (trayWin && trayWin.isVisible()) {
        trayWin.hide();
      }
    });
  }

  trayWin.webContents.send('tray-data', { instances, theme: config.theme || 'dark' });
  positionTrayWin(trayBounds, popupWidth, popupHeight);
  trayWin.show();
  trayWin.focus();
}

function positionTrayWin(trayBounds, width, height) {
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const taskbarOnTop = trayBounds.y < display.bounds.height / 2;

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  let y;
  if (taskbarOnTop) {
    y = trayBounds.y + trayBounds.height + 4;
  } else {
    y = trayBounds.y - height - 4;
  }

  // Keep within screen bounds
  x = Math.max(display.bounds.x, Math.min(x, display.bounds.x + display.bounds.width - width));
  y = Math.max(display.bounds.y, Math.min(y, display.bounds.y + display.bounds.height - height));

  trayWin.setPosition(x, y);
}

function createTrayIcon() {
  // Use the official Claude tray icon
  const iconPath = path.join(__dirname, 'resources', 'tray.png');
  return nativeImage.createFromPath(iconPath);
}

module.exports = { setupTray };
