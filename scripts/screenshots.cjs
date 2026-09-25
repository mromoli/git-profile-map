// Regenerates the README screenshots from a made-up setup: `npm run screenshots` (macOS or Linux).
// Everything lives in a temporary folder. HOME, the SSH config, app data and connection checks are
// all redirected, so no real account, path or credential is read, written or contacted.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const out = path.join(__dirname, '..', 'docs', 'screenshots');
const demo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-profile-demo-')));
const home = path.join(demo, 'sam');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

write(path.join(home, '.gitconfig'), `[user]
  name = Sam Okafor
  email = sam@okafor.example
[credential]
  helper = osxkeychain
[includeIf "gitdir:~/Work/"]
  path = ~/.gitconfig-work
`);
write(path.join(home, '.gitconfig-work'), '[user]\n  email = sam.okafor@larkspur.example\n');
write(path.join(home, '.ssh', 'config'), `Host github-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
  IdentitiesOnly yes

Host github-work
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_larkspur
  IdentitiesOnly yes

Host gitlab-work
  HostName gitlab.com
  User git
  IdentityFile ~/.ssh/id_ed25519_larkspur_gitlab
  IdentitiesOnly yes
`);

const repos = {
  'Work/checkout-service': { origin: 'git@github-work:larkspur/checkout-service.git' },
  'Work/design-tokens': { origin: 'https://github.com/larkspur/design-tokens.git', config: [['credential.https://github.com.username', 'sam-larkspur']] },
  'Personal/dotfiles': { origin: 'git@github-personal:samokafor/dotfiles.git' },
  'Personal/trail-journal': { origin: 'https://github.com/samokafor/trail-journal.git' }
};
const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
for (const [dir, repo] of Object.entries(repos)) {
  const cwd = path.join(home, dir);
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd, env });
  execFileSync('git', ['remote', 'add', 'origin', repo.origin], { cwd, env });
  for (const [key, value] of repo.config || []) execFileSync('git', ['config', '--local', key, value], { cwd, env });
}

// ssh reads the real user's ~/.ssh/config (it ignores HOME), so a wrapper points it at the demo one.
const realSsh = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
write(path.join(demo, 'bin', 'ssh'), `#!/bin/sh\nexec "${realSsh}" -F "${path.join(home, '.ssh', 'config')}" "$@"\n`);
fs.chmodSync(path.join(demo, 'bin', 'ssh'), 0o755);

Object.assign(process.env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', PATH: `${path.join(demo, 'bin')}${path.delimiter}${process.env.PATH}` });
const userData = path.join(demo, 'app-data');
const roots = Object.keys(repos).map(dir => path.join(home, dir));
write(path.join(userData, 'favorites.json'), JSON.stringify(roots));
write(path.join(userData, 'https-profiles.json'), JSON.stringify([{ id: 'github.com:sam-larkspur', provider: 'github', host: 'github.com', username: 'sam-larkspur' }]));
app.setPath('userData', userData);

require('../src/main.cjs');
const core = require('../src/core.cjs');

// Canned connection results instead of contacting GitHub.
const minutesAgo = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const statuses = {
  'checkout-service': { ...core.classifyProbe({ ok: true }, 'read'), checkedAt: minutesAgo(2) },
  'design-tokens': { ...core.classifyProbe({ ok: true }, 'read'), checkedAt: minutesAgo(2) },
  dotfiles: { ...core.classifyProbe({ ok: true }, 'read'), checkedAt: minutesAgo(3) },
  'trail-journal': { ...core.classifyProbe({ ok: false, output: 'fatal: could not read Username for https://github.com: terminal prompts disabled' }, 'read'), checkedAt: minutesAgo(3) }
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Native vibrancy and window chrome are not part of a page capture, so the frame is drawn in CSS.
const frameCss = theme => `
  html, html body { background: ${theme === 'dark' ? 'radial-gradient(1200px 800px at 20% 0%, #3a4660, #1b1f2a 70%)' : 'radial-gradient(1200px 800px at 20% 0%, #dfe7f3, #b9c6d8 75%)'} !important; }
  .app { height: calc(100vh - 80px) !important; margin: 40px; border-radius: 14px; overflow: hidden; position: relative;
    background: ${theme === 'dark' ? '#2b2d33' : '#e9ebef'}; box-shadow: 0 0 0 .5px rgba(0,0,0,.25), 0 30px 70px -20px rgba(10,20,40,.45); }
  .app::before { content: ""; position: absolute; left: 22px; top: 22px; width: 12px; height: 12px; border-radius: 50%; z-index: 5;
    background: #ff5f57; box-shadow: 20px 0 0 #febc2e, 40px 0 0 #28c840; }
  main { height: auto !important; }
  .drag-strip { display: none; }
  main::-webkit-scrollbar { display: none; }
  /* A hidden window pauses transitions, which would freeze colours mid-way between themes. */
  *, *::before, *::after { transition: none !important; animation: none !important; }`;

app.whenReady().then(async () => {
  ipcMain.removeHandler('connection-check');
  ipcMain.handle('connection-check', (_event, folder, kind) => ({ ...statuses[path.basename(folder)], root: folder, kind }));
  ipcMain.removeHandler('appearance');
  ipcMain.handle('appearance', () => ({ platform: 'darwin', home, version: require('../package.json').version, theme: nativeTheme.themeSource, accent: null }));

  await wait(1200);
  const win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1360, 900);
  win.webContents.setBackgroundThrottling(false);
  const js = code => win.webContents.executeJavaScript(code);
  const until = async code => { for (let i = 0; i < 100 && !(await js(code)); i++) await wait(100); };
  fs.mkdirSync(out, { recursive: true });
  let css = null;
  const snap = async (name, theme) => {
    nativeTheme.themeSource = theme;
    if (css) await win.webContents.removeInsertedCSS(css);
    css = await win.webContents.insertCSS(frameCss(theme));
    await js(`showTheme(${JSON.stringify(theme)})`);
    await wait(900);
    const image = (await win.capturePage()).resize({ width: 1600, quality: 'best' });
    fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    console.log(`wrote docs/screenshots/${name}.png`);
  };
  const open = async root => {
    await js(`document.getElementById('path').value = ${JSON.stringify(root)}; document.getElementById('inspect').click()`);
    await until("!document.getElementById('results').classList.contains('hidden')");
  };

  await until("document.querySelectorAll('.watch-badge.healthy').length === 3");
  await open(roots[0]);
  await js("document.getElementById('check-remote').click()");
  await until("document.querySelector('.connection-panel').dataset.state === 'healthy'");
  await snap('repository', 'light');

  await js("document.getElementById('nav-watchlist').click()");
  await snap('watchlist', 'dark');

  await js("document.getElementById('nav-new-profile').click()");
  await until("document.querySelectorAll('.profile-row').length === 4");
  await snap('profiles', 'light');

  await open(roots[3]);
  await js(`const select = document.getElementById('new-target');
    select.value = 'ssh:github-personal';
    document.getElementById('preview').click()`);
  await until("!document.getElementById('modal').classList.contains('hidden')");
  await snap('review', 'dark');

  fs.rmSync(demo, { recursive: true, force: true });
  app.exit(0);
});
