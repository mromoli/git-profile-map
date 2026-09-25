const { app, BrowserWindow, dialog, ipcMain, clipboard, shell, systemPreferences, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const core = require('./core.cjs');
const { createFavorites } = require('./favorites.cjs');
const { createSshProfile } = require('./ssh-setup.cjs');
const { createHttpsProfiles } = require('./https-setup.cjs');
const { providers, settingsPages } = require('./providers.cjs');

// macOS gets a translucent window with native vibrancy under the sidebar; Windows 11 gets Mica.
function platformWindowOptions() {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' };
  if (process.platform === 'win32') return { backgroundMaterial: 'mica', backgroundColor: '#00000000' };
  return { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d20' : '#f5f5f7' };
}

function createWindow() {
  const win = new BrowserWindow({ width: 1180, height: 800, minWidth: 880, minHeight: 620, title: 'Git Profile Map', ...platformWindowOptions(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// Appearance is set natively so window vibrancy and prefers-color-scheme follow it together.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; }
}

app.whenReady().then(() => {
  const saved = readSettings().theme;
  if (['system', 'light', 'dark'].includes(saved)) nativeTheme.themeSource = saved;
  ipcMain.handle('theme-set', (_event, theme) => {
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Unknown appearance.');
    nativeTheme.themeSource = theme;
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), theme }, null, 2), { mode: 0o600 });
    return theme;
  });
  const favorites = createFavorites(path.join(app.getPath('userData'), 'favorites.json'));
  const httpsProfiles = createHttpsProfiles(path.join(app.getPath('userData'), 'https-profiles.json'));
  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('appearance', () => ({ platform: process.platform, version: app.getVersion(), theme: nativeTheme.themeSource, accent: ['darwin', 'win32'].includes(process.platform) ? systemPreferences.getAccentColor?.() || null : null }));
  ipcMain.handle('providers', () => providers);
  ipcMain.handle('inspect', (_event, folder) => core.inspect(folder));
  ipcMain.handle('profiles', async () => ({ ...await core.profiles(), httpsProfiles: await httpsProfiles.list() }));
  ipcMain.handle('https-profile-create', (_event, request) => httpsProfiles.create(request));
  ipcMain.handle('https-profile-remove', (_event, id) => httpsProfiles.remove(id));
  ipcMain.handle('ssh-profile-create', (_event, request) => createSshProfile(request));
  ipcMain.handle('public-key-copy', (_event, value) => { clipboard.writeText(String(value)); });
  ipcMain.handle('account-settings-open', (_event, url) => {
    if (!settingsPages.includes(url)) throw new Error('Unknown account settings page.');
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
