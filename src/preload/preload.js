const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Instance CRUD
  getInstances: () => ipcRenderer.invoke('get-instances'),
  createInstance: (name) => ipcRenderer.invoke('create-instance', name),
  deleteInstance: (id) => ipcRenderer.invoke('delete-instance', id),
  renameInstance: (id, name) => ipcRenderer.invoke('rename-instance', id, name),

  // Instance lifecycle
  launchInstance: (id) => ipcRenderer.invoke('launch-instance', id),
  stopInstance: (id) => ipcRenderer.invoke('stop-instance', id),
  launchAll: () => ipcRenderer.invoke('launch-all'),
  stopAll: () => ipcRenderer.invoke('stop-all'),

  // Preferences
  toggleFavourite: (id) => ipcRenderer.invoke('toggle-favourite', id),
  toggleAutoLaunch: (id) => ipcRenderer.invoke('toggle-autolaunch', id),

  // Theme
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),

  // Events from main (remove previous listeners to prevent duplicates on reload)
  onInstanceUpdate: (callback) => {
    ipcRenderer.removeAllListeners('instance-update');
    ipcRenderer.on('instance-update', (_, data) => callback(data));
  },
  onMaximizeChange: (callback) => {
    ipcRenderer.removeAllListeners('maximize-change');
    ipcRenderer.on('maximize-change', (_, isMaximized) => callback(isMaximized));
  }
});
