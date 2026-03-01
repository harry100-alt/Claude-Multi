const { ipcMain, shell } = require('electron');
const net = require('net');
const {
  createInstance, deleteInstance, renameInstance,
  toggleFavourite, toggleAutoLaunch,
  launchInstance, stopInstance, launchAll, stopAll,
  getAllInstances, autoLaunchInstances, reconcileInstances
} = require('./instances');
const { loadConfig, saveConfig } = require('./config');

const PIPE_NAME = '\\\\.\\pipe\\claude-multi-conflicts';

function setupIpcHandlers(mainWindow) {
  // Detect pre-existing instances from disk and running processes
  reconcileInstances();

  ipcMain.handle('get-instances', async () => getAllInstances());
  ipcMain.handle('create-instance', (_, name) => createInstance(name));
  ipcMain.handle('delete-instance', (_, id) => deleteInstance(id));
  ipcMain.handle('rename-instance', (_, id, name) => renameInstance(id, name));
  ipcMain.handle('launch-instance', (_, id) => launchInstance(id));
  ipcMain.handle('stop-instance', (_, id) => stopInstance(id));
  ipcMain.handle('toggle-favourite', (_, id) => toggleFavourite(id));
  ipcMain.handle('toggle-autolaunch', (_, id) => toggleAutoLaunch(id));
  ipcMain.handle('launch-all', () => launchAll());
  ipcMain.handle('stop-all', () => stopAll());

  ipcMain.handle('get-theme', () => loadConfig().theme);
  ipcMain.handle('set-theme', (_, theme) => {
    const config = loadConfig();
    config.theme = theme;
    saveConfig(config);
  });

  // Shell — only allow https URLs
  ipcMain.handle('open-external', (_, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  // Window controls
  ipcMain.handle('window-minimize', () => mainWindow.minimize());
  ipcMain.handle('window-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.handle('window-close', () => mainWindow.hide());

  // Forward maximize state changes to renderer
  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('maximize-change', true);
    }
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('maximize-change', false);
    }
  });

  // Push status updates every 2 seconds (async, with overlap protection)
  let polling = false;
  setInterval(async () => {
    if (polling || !mainWindow || mainWindow.isDestroyed()) return;
    polling = true;
    try {
      mainWindow.webContents.send('instance-update', await getAllInstances());
    } catch {} finally {
      polling = false;
    }
  }, 2000);

  // Dismiss conflict — remove alwaysOnTop
  ipcMain.handle('dismiss-conflict', () => mainWindow.setAlwaysOnTop(false));

  // Named pipe server — receives conflict notifications from patched Claude instances
  const pipeServer = net.createServer((conn) => {
    let data = '';
    conn.on('data', (chunk) => { data += chunk; });
    conn.on('end', () => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'conflict' && msg.pid) {
          let conflictName = `PID ${msg.pid}`;
          getAllInstances()
            .then((all) => {
              const match = all.find(i => i.pid === msg.pid);
              if (match) conflictName = match.name;
            })
            .catch(() => {})
            .finally(() => {
              if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('session-conflict', conflictName);
                mainWindow.setAlwaysOnTop(true);
                mainWindow.show();
                mainWindow.focus();
              }
            });
        }
      } catch {}
    });
  });
  pipeServer.on('error', () => {});
  pipeServer.listen(PIPE_NAME);

  // Auto-launch on startup (after a short delay for UI to load)
  setTimeout(() => autoLaunchInstances().catch(e => console.error('Auto-launch failed:', e)), 3000);
}

module.exports = { setupIpcHandlers };
