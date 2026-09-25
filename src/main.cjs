const { app, BrowserWindow, dialog, ipcMain, clipboard, shell } = require('electron');
const path = require('node:path');
const core = require('./core.cjs');
const { createFavorites } = require('./favorites.cjs');
const { createSshProfile } = require('./ssh-setup.cjs');

function createWindow() {
  const win = new BrowserWindow({ width: 1180, height: 790, minWidth: 850, minHeight: 620,
    backgroundColor: '#f6f5f2', title: 'Git Profile Map',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  const favorites = createFavorites(path.join(app.getPath('userData'), 'favorites.json'));
  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('inspect', (_event, folder) => core.inspect(folder));
  ipcMain.handle('profiles', () => core.profiles());
  ipcMain.handle('ssh-profile-create', (_event, request) => createSshProfile(request));
  ipcMain.handle('public-key-copy', (_event, value) => { clipboard.writeText(String(value)); });
  ipcMain.handle('ssh-key-settings-open', (_event, url) => {
    if (!['https://github.com/settings/ssh/new', 'https://gitlab.com/-/user_settings/ssh_keys', 'https://bitbucket.org/account/settings/ssh-keys/'].includes(url)) throw new Error('Unknown key settings page.');
    return shell.openExternal(url);
  });
  ipcMain.handle('preview', async (_event, folder, request) => core.switchPreview(await core.inspect(folder), request));
  ipcMain.handle('apply', (_event, folder, request) => core.applySwitch(folder, request));
  ipcMain.handle('favorites-list', () => favorites.list());
  ipcMain.handle('favorites-add', async (_event, folder) => favorites.add((await core.inspect(folder)).root));
  ipcMain.handle('favorites-remove', (_event, root) => favorites.remove(root));
  ipcMain.handle('connection-check', (_event, folder, kind) => core.checkConnection(folder, kind));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
