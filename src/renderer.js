const $ = id => document.getElementById(id);
const api = window.profileMap;
let current = null;
let proposed = null;
let createdProfile = null;
let providers = {};
let knownProfiles = { sshHosts: [], hostTargets: {}, httpsProfiles: [] };
let watchPaths = [];
const watchStatuses = new Map();
const watchProfiles = new Map();
const checking = new Set();
const text = (id, value) => { $(id).textContent = value || '—'; };
const sourceName = record => record ? `${record.scope} · ${record.source.replace(/^file:/, '')}` : 'No setting found';
const baseName = root => root.split(/[\\/]/).filter(Boolean).at(-1) || root;
const showNotice = (message, kind = 'error') => { $('notice').textContent = message; $('notice').classList.toggle('info', kind === 'info'); $('notice').classList.remove('hidden'); };
const showError = error => showNotice(error.message || String(error));
const clearError = () => $('notice').classList.add('hidden');

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function iconButton(name, label, onClick) {
  const button = el('button', 'icon-button');
  button.title = label; button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

async function busy(button, task) {
  button.disabled = true;
  try { return await task(); } finally { button.disabled = false; }
}

function showView(view) {
  $('overview-view').classList.toggle('hidden', view !== 'overview');
  $('watchlist').classList.toggle('hidden', view !== 'watchlist');
  $('new-profile-view').classList.toggle('hidden', view !== 'new-profile');
  $('results').classList.toggle('hidden', view !== 'repository');
  for (const [name, id] of [['overview', 'nav-overview'], ['watchlist', 'nav-watchlist'], ['new-profile', 'nav-new-profile'], ['repository', 'nav-repository']])
    $(id).classList.toggle('selected', view === name);
  clearError();
  $('main').scrollTo(0, 0);
  if (view === 'new-profile') refreshProfiles().then(renderProfileList).catch(showError);
}

async function refreshProfiles() {
  knownProfiles = await api.profiles();
  return knownProfiles;
}

/* Watchlist */

const statusClass = status => status?.state || 'unchecked';
const statusLabel = status => status?.title || 'Not checked';
const formatTime = status => status?.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'No recent check';

function signInSummary(config) {
  if (config.remote.method === 'ssh') return `SSH · ${config.remote.host}`;
  if (config.remote.method === 'https') return `HTTPS · ${config.httpsUser || 'no account set'}`;
  return null;
}

function renderWatchlist() {
  $('watch-count').textContent = watchPaths.length ? String(watchPaths.length) : '';
  $('watch-items').replaceChildren();
  if (!watchPaths.length) {
    $('watch-items').append(el('p', 'watch-empty', 'No saved repositories yet. Inspect a folder, then choose “Save to watchlist”.'));
  }
  for (const root of watchPaths) {
    const item = el('article', 'watch-item');
    const main = el('div', 'watch-main');
    const config = watchProfiles.get(root);
    const profile = config
      ? [config.name?.value || 'No commit name', config.email?.value || 'No commit email', signInSummary(config)].filter(Boolean).join(' · ')
      : watchProfiles.has(root) ? 'Profile unavailable' : 'Reading Git profile…';
    const status = watchStatuses.get(root);
    main.append(el('strong', '', baseName(root)), el('span', 'watch-profile', profile), el('span', '', root),
      el('small', '', status?.detail ? `${status.detail} · ${formatTime(status)}` : formatTime(status)));
    const actions = el('div', 'watch-actions');
    const badge = el('span', `watch-badge ${statusClass(status)}`, checking.has(root) ? 'Checking…' : statusLabel(status));
    const open = el('button', 'secondary', 'Open');
    open.addEventListener('click', async () => { try { await render(root); } catch (error) { showError(error); } });
    const refresh = iconButton('refresh', `Check ${baseName(root)}`, () => checkOne(root));
    const remove = iconButton('close', `Remove ${baseName(root)} from watchlist`, async () => {
      try { watchPaths = await api.favoriteRemove(root); watchStatuses.delete(root); watchProfiles.delete(root); renderWatchlist(); }
      catch (error) { showError(error); }
    });
    actions.append(badge, open, refresh, remove);
    item.append(main, actions);
    $('watch-items').append(item);
  }
  updateFavoriteButton();
}

async function refreshWatchProfile(root) {
  try { watchProfiles.set(root, await api.inspect(root)); }
  catch { watchProfiles.set(root, null); }
  renderWatchlist();
}

function updateFavoriteButton() {
  if (!current) return;
  const saved = watchPaths.includes(current.root);
  $('favorite').classList.toggle('saved', saved);
  $('favorite').querySelector('span').textContent = saved ? 'Saved to watchlist' : 'Save to watchlist';
}

function showConnection(status) {
  document.querySelector('.connection-panel').dataset.state = status.state;
  text('connection-title', status.title);
  $('connection-detail').textContent = status.detail || '';
  $('connection-time').textContent = status.checkedAt ? formatTime(status) : '';
}

async function checkOne(root, kind = 'read') {
  if (checking.has(root)) return;
  checking.add(root); renderWatchlist();
  if (current?.root === root) showConnection({ state: 'checking', title: kind === 'push' ? 'Testing push…' : 'Checking…', detail: 'Contacting the remote without any sign-in prompt.' });
  try {
    const result = await api.checkConnection(root, kind);
    watchStatuses.set(root, result);
    if (current?.root === root) showConnection(result);
  } catch (error) {
    const status = { state: 'attention', title: 'Repository unavailable', detail: error.message || String(error), checkedAt: new Date().toISOString() };
    watchStatuses.set(root, status);
    if (current?.root === root) showConnection(status);
  } finally { checking.delete(root); renderWatchlist(); }
}

async function checkAll() {
  await busy($('refresh-all'), async () => {
    const queue = [...watchPaths];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) await checkOne(queue.shift());
    }));
  });
}

/* Repository */

function addOrigin(label, value) {
  const row = el('div', 'origin-row');
  row.append(el('strong', '', label), el('span', '', value));
  $('origins').append(row);
}

function renderSignIn(data) {
  const method = data.remote.method;
  text('auth-method', ({ ssh: 'SSH', https: 'HTTPS', local: 'LOCAL', none: 'NONE' })[method]);
  text('remote-url', data.origin?.value || 'No origin configured');
  $('ssh-target').textContent = ''; $('ssh-key').textContent = ''; $('auth-detail').textContent = '';
  if (method === 'ssh') {
    text('ssh-host', data.remote.host);
    if (data.ssh?.hostname) $('ssh-target').textContent = `Connects to ${data.ssh.user}@${data.ssh.hostname}`;
    $('ssh-key').textContent = data.ssh?.identityFiles?.length ? `Key: ${data.ssh.identityFiles.join(', ')}` : 'No SSH key resolved';
    if (data.coreSshCommand) $('auth-detail').textContent = `SSH command override: ${data.coreSshCommand.value}`;
  } else if (method === 'https') {
    text('ssh-host', data.httpsUser || 'No account chosen');
    $('ssh-target').textContent = data.httpsUser ? `Signs in to ${data.remote.host} as ${data.httpsUser}` : `The credential helper picks any saved login for ${data.remote.host}`;
    $('auth-detail').textContent = `Credential helper: ${data.credentialHelper?.value || 'not configured'}`;
  } else {
    text('ssh-host', method === 'local' ? 'Local path' : 'No origin remote');
  }
}

function renderTargets(data) {
  const select = $('new-target');
  select.replaceChildren(new Option('Keep current sign-in', ''));
  const hostname = data.hostname;
  const ssh = knownProfiles.sshHosts.filter(host => knownProfiles.hostTargets[host] === hostname);
  const https = knownProfiles.httpsProfiles.filter(profile => profile.host === hostname);
  const group = (label, options) => {
    if (!options.length) return;
    const node = document.createElement('optgroup'); node.label = label;
    for (const [name, value] of options) node.append(new Option(name, value));
    select.append(node);
  };
  group('SSH', ssh.map(host => [host, `ssh:${host}`]));
  group('HTTPS', https.map(profile => [`${profile.username} (HTTPS)`, `https:${profile.username}`]));
  const count = ssh.length + https.length;
  select.disabled = !hostname || !count;
  $('host-help').textContent = !hostname ? 'Add an SSH or HTTPS origin to use a sign-in profile.'
    : !count ? `No profile for ${hostname} yet. Create one under Profiles.`
    : `Profiles for ${hostname}. Switching can convert between SSH and HTTPS.`;
}

async function render(folder) {
  clearError();
  const data = await api.inspect(folder);
  current = data;
  if (watchPaths.includes(data.root)) watchProfiles.set(data.root, data);
  updateFavoriteButton();
  $('path').value = data.root;
  text('path-hint', 'Repository found');
  text('repo-name', baseName(data.root));
  $('nav-repository-label').textContent = baseName(data.root);
  text('repo-path', data.root);
  text('identity-name', data.name?.value || 'No name set');
  text('identity-email', data.email?.value || 'No email set');
  $('identity-source').textContent = `Name from ${data.name?.scope || 'nowhere'} · email from ${data.email?.scope || 'nowhere'} config`;
  renderSignIn(data);
  $('origins').replaceChildren();
  addOrigin('Commit name', sourceName(data.name));
  addOrigin('Commit email', sourceName(data.email));
  addOrigin('Origin remote', sourceName(data.origin));
  if (data.pushUrl) addOrigin('Push URL', `${data.pushUrl.value} · ${sourceName(data.pushUrl)}`);
  if (data.credentialHelper) addOrigin('Credential helper', sourceName(data.credentialHelper));
  if (data.credentialUser) addOrigin('HTTPS account', sourceName(data.credentialUser));
  if (data.coreSshCommand) addOrigin('SSH command', sourceName(data.coreSshCommand));
  for (const include of data.conditionalIncludes) addOrigin('Folder rule', include.rule);
  $('new-name').value = data.name?.value || '';
  $('new-email').value = data.email?.value || '';
  await refreshProfiles();
  renderTargets(data);
  $('nav-repository').classList.remove('hidden');
  showView('repository');
  if (data.embeddedSecret) showNotice('This remote URL contains a password or token, readable by anything that can open .git/config. Switch to an SSH or HTTPS profile to remove it from the URL.');
  const savedStatus = watchStatuses.get(data.root);
  if (savedStatus) showConnection(savedStatus);
  else showConnection({ state: 'unchecked', title: 'Not checked yet', detail: 'Check whether Git can reach this remote without asking you to sign in.' });
}

/* Profiles */

function setMethod(method) {
  for (const [name, id] of [['ssh', 'method-ssh'], ['https', 'method-https']]) {
    $(id).classList.toggle('selected', method === name);
    $(id).setAttribute('aria-selected', String(method === name));
  }
  $('setup-form').classList.toggle('hidden', method !== 'ssh' || Boolean(createdProfile));
  $('setup-complete').classList.toggle('hidden', method !== 'ssh' || !createdProfile);
  const httpsDone = $('https-complete').dataset.done === 'true';
  $('https-form').classList.toggle('hidden', method !== 'https' || httpsDone);
  $('https-complete').classList.toggle('hidden', method !== 'https' || !httpsDone);
}

function renderProfileList() {
  const list = $('profile-list');
  list.replaceChildren();
  const row = (iconName, title, detail, action) => {
    const node = el('div', 'profile-row');
    const badge = el('span', 'profile-icon'); badge.append(icon(iconName));
    const copy = el('div'); copy.append(el('strong', '', title), el('span', '', detail));
    node.append(badge, copy);
    if (action) node.append(action);
    list.append(node);
  };
  list.append(el('p', 'profile-group', 'SSH keys · from ~/.ssh/config'));
  if (!knownProfiles.sshHosts.length) list.append(el('p', 'profile-empty', 'No SSH host aliases yet.'));
  for (const host of knownProfiles.sshHosts) row('key', host, knownProfiles.hostTargets[host] ? `Connects to ${knownProfiles.hostTargets[host]}` : 'Host not resolved');
  list.append(el('p', 'profile-group', 'HTTPS logins'));
  if (!knownProfiles.httpsProfiles.length) list.append(el('p', 'profile-empty', 'No HTTPS profiles yet.'));
  for (const profile of knownProfiles.httpsProfiles) {
    row('lock', profile.username, profile.host, iconButton('close', `Remove ${profile.username}`, async () => {
      try { await api.removeHttpsProfile(profile.id); await refreshProfiles(); renderProfileList(); }
      catch (error) { showError(error); }
    }));
  }
}

function fillProviders() {
  for (const id of ['setup-provider', 'https-provider']) {
    $(id).replaceChildren(...Object.entries(providers).map(([key, provider]) => new Option(`${provider.label} · ${provider.hostname}`, key)));
  }
}

$('method-ssh').addEventListener('click', () => setMethod('ssh'));
$('method-https').addEventListener('click', () => setMethod('https'));

$('create-profile').addEventListener('click', () => busy($('create-profile'), async () => {
  clearError();
  try {
    createdProfile = await api.createSshProfile({ provider: $('setup-provider').value, alias: $('setup-alias').value, email: $('setup-email').value, passphrase: $('setup-passphrase').value });
    $('setup-passphrase').value = '';
    text('created-profile-name', createdProfile.alias);
    $('created-public-key').value = createdProfile.publicKey;
    setMethod('ssh');
    await refreshProfiles(); renderProfileList();
  } catch (error) { showError(error); }
}));
$('copy-public-key').addEventListener('click', async () => {
  if (!createdProfile) return;
  await api.copyPublicKey(createdProfile.publicKey);
  $('copy-public-key').lastChild.textContent = 'Copied';
});
$('open-key-settings').addEventListener('click', async () => { if (createdProfile) { try { await api.openAccountSettings(createdProfile.keyUrl); } catch (error) { showError(error); } } });
$('another-profile').addEventListener('click', () => {
  createdProfile = null; $('setup-alias').value = ''; $('setup-email').value = '';
  $('copy-public-key').lastChild.textContent = 'Copy public key';
  setMethod('ssh');
});

$('open-token-page').addEventListener('click', async () => {
  const provider = providers[$('https-provider').value];
  if (provider) { try { await api.openAccountSettings(provider.tokenUrl); } catch (error) { showError(error); } }
});
$('create-https').addEventListener('click', () => busy($('create-https'), async () => {
  clearError();
  try {
    const result = await api.createHttpsProfile({ provider: $('https-provider').value, username: $('https-username').value, token: $('https-token').value });
    $('https-token').value = '';
    text('https-complete-name', `${result.profile.username} on ${result.profile.host}`);
    $('https-complete-detail').textContent = result.tokenSaved
      ? `The token was saved by your credential helper (${result.helper}). Open a repository and pick this profile under “Switch this repository”.`
      : 'No token saved. Git will ask you to sign in the first time this profile is used, and your credential helper will remember it.';
    $('https-complete').dataset.done = 'true';
    setMethod('https');
    await refreshProfiles(); renderProfileList();
  } catch (error) { showError(error); }
}));
$('another-https').addEventListener('click', () => {
  $('https-complete').dataset.done = 'false'; $('https-username').value = '';
  setMethod('https');
});

/* Switch */

$('preview').addEventListener('click', async () => {
  try {
    clearError();
    const [type, ...rest] = $('new-target').value.split(':');
    proposed = { name: $('new-name').value, email: $('new-email').value, target: type ? { type, value: rest.join(':') } : null,
      expectedRoot: current.root, expectedRemote: current.origin?.value || '' };
    const preview = await api.preview(current.root, proposed);
    if (!preview.changes.length) { showNotice('These settings are already in effect.', 'info'); return; }
    $('changes').replaceChildren();
    for (const item of preview.changes) {
      const row = el('div', 'change');
      row.append(el('strong', '', item.label), el('span', 'from', item.from), el('span', 'to', item.to));
      $('changes').append(row);
    }
    $('modal').classList.remove('hidden');
    $('apply').focus();
  } catch (error) { showError(error); }
});
const close = () => $('modal').classList.add('hidden');
$('close').addEventListener('click', close);
$('cancel').addEventListener('click', close);
$('modal').addEventListener('click', event => { if (event.target === $('modal')) close(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('modal').classList.contains('hidden')) close(); });
$('apply').addEventListener('click', () => busy($('apply'), async () => {
  try { await api.apply(current.root, proposed); close(); await render(current.root); showNotice('Switch applied.', 'info'); }
  catch (error) { close(); showError(error); }
}));

/* Navigation and start-up */

$('nav-watchlist').addEventListener('click', () => showView('watchlist'));
$('nav-new-profile').addEventListener('click', () => showView('new-profile'));
$('nav-overview').addEventListener('click', () => showView('overview'));
$('nav-repository').addEventListener('click', () => { if (current) showView('repository'); });
$('back-overview').addEventListener('click', () => showView('overview'));
$('favorite').addEventListener('click', async () => {
  if (!current) return;
  try {
    watchPaths = watchPaths.includes(current.root) ? await api.favoriteRemove(current.root) : await api.favoriteAdd(current.root);
    if (watchPaths.includes(current.root)) { watchProfiles.set(current.root, current); checkOne(current.root); }
    renderWatchlist();
  } catch (error) { showError(error); }
});
$('refresh-all').addEventListener('click', checkAll);
$('check-remote').addEventListener('click', () => { if (current) checkOne(current.root); });
$('check-push').addEventListener('click', () => { if (current) checkOne(current.root, 'push'); });
$('browse').addEventListener('click', async () => {
  const folder = await api.pickFolder();
  if (folder) { $('path').value = folder; try { await render(folder); } catch (error) { showError(error); } }
});
$('inspect').addEventListener('click', () => busy($('inspect'), async () => { try { await render($('path').value); } catch (error) { showError(error); } }));
$('path').addEventListener('keydown', event => { if (event.key === 'Enter') $('inspect').click(); });

function showTheme(theme) {
  for (const button of document.querySelectorAll('.theme-switch button')) button.setAttribute('aria-checked', String(button.dataset.theme === theme));
}
for (const button of document.querySelectorAll('.theme-switch button')) {
  button.addEventListener('click', async () => { try { showTheme(await api.setTheme(button.dataset.theme)); } catch (error) { showError(error); } });
}

api.appearance().then(({ platform, accent, theme }) => {
  document.documentElement.dataset.platform = platform;
  showTheme(theme);
  if (accent) document.documentElement.style.setProperty('--accent', `#${accent.slice(0, 6)}`);
}).catch(() => {});
api.providers().then(found => { providers = found; fillProviders(); }).catch(showError);
api.favorites().then(paths => { watchPaths = paths; renderWatchlist(); for (const root of paths) refreshWatchProfile(root); checkAll(); }).catch(showError);
setInterval(() => { if (!document.hidden && watchPaths.length) checkAll(); }, 5 * 60 * 1000);
