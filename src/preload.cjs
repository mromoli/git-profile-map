const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('profileMap', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  inspect: folder => ipcRenderer.invoke('inspect', folder),
  profiles: () => ipcRenderer.invoke('profiles'),
  createSshProfile: request => ipcRenderer.invoke('ssh-profile-create', request),
  copyPublicKey: value => ipcRenderer.invoke('public-key-copy', value),
  openKeySettings: url => ipcRenderer.invoke('ssh-key-settings-open', url),
  preview: (folder, request) => ipcRenderer.invoke('preview', folder, request),
  apply: (folder, request) => ipcRenderer.invoke('apply', folder, request),
  favorites: () => ipcRenderer.invoke('favorites-list'),
  favoriteAdd: folder => ipcRenderer.invoke('favorites-add', folder),
  favoriteRemove: root => ipcRenderer.invoke('favorites-remove', root),
  checkConnection: (folder, kind) => ipcRenderer.invoke('connection-check', folder, kind)
});
