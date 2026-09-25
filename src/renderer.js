const $ = id => document.getElementById(id);
let current = null;
let proposed = null;
let createdProfile = null;
let watchPaths = [];
const watchStatuses = new Map();
const watchProfiles = new Map();
const checking = new Set();
const text = (id, value) => { $(id).textContent = value || '—'; };
const sourceName = record => record ? `${record.scope} · ${record.source.replace(/^file:/, '')}` : 'No setting found';
const showError = error => { $('notice').textContent = error.message || String(error); $('notice').classList.remove('hidden'); };
const clearError = () => $('notice').classList.add('hidden');

function showView(view) {
  $('overview-view').classList.toggle('hidden', view !== 'overview');
  $('watchlist').classList.toggle('hidden', view !== 'watchlist');
  $('new-profile-view').classList.toggle('hidden', view !== 'new-profile');
  $('results').classList.toggle('hidden', view !== 'repository');
  for (const [name, id] of [['overview', 'nav-overview'], ['watchlist', 'nav-watchlist'], ['new-profile', 'nav-new-profile'], ['repository', 'nav-repository']]) {
    $(id).classList.toggle('selected', view === name);
  }
  clearError();
  window.scrollTo(0, 0);
}

function statusClass(status) { return status?.state || 'unchecked'; }
function statusLabel(status) { return status?.title || 'Not checked'; }
function formatTime(status) { return status?.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleString()}` : 'No recent check'; }

function renderWatchlist() {
  $('watch-count').textContent = String(watchPaths.length);
  $('watch-items').replaceChildren();
  if (!watchPaths.length) {
    const empty = document.createElement('p'); empty.className = 'watch-empty';
    empty.textContent = 'No saved repositories yet. Inspect a folder, then choose “Save to watchlist”.';
    $('watch-items').append(empty);
  }
  for (const root of watchPaths) {
    const item = document.createElement('article'); item.className = 'watch-item';
    const left = document.createElement('div'); left.className = 'watch-main';
    const title = document.createElement('strong'); title.textContent = root.split(/[\\/]/).filter(Boolean).at(-1) || root;
    const location = document.createElement('span'); location.textContent = root;
    const profile = document.createElement('span'); profile.className = 'watch-profile';
    const config = watchProfiles.get(root);
    profile.textContent = config ? `Profile: ${config.name?.value || 'No commit name'} · ${config.email?.value || 'No commit email'}${config.remote.method === 'ssh' ? ` · SSH: ${config.remote.host}` : ''}` : watchProfiles.has(root) ? 'Profile unavailable' : 'Reading Git profile…';
    const status = watchStatuses.get(root);
    const badge = document.createElement('span'); badge.className = `watch-badge ${statusClass(status)}`;
    badge.textContent = checking.has(root) ? 'Checking…' : statusLabel(status);
    const time = document.createElement('small'); time.textContent = status?.detail ? `${status.detail} · ${formatTime(status)}` : formatTime(status);
    left.append(title, location, profile, time);
    const actions = document.createElement('div'); actions.className = 'watch-actions';
    const open = document.createElement('button'); open.className = 'secondary'; open.textContent = 'Open';
    open.addEventListener('click', async () => { try { await render(root); } catch (error) { showError(error); } });
    const refresh = document.createElement('button'); refresh.className = 'icon-button'; refresh.title = 'Check connection'; refresh.setAttribute('aria-label', `Check ${title.textContent}`); refresh.textContent = '↻';
    refresh.addEventListener('click', () => checkOne(root));
    const remove = document.createElement('button'); remove.className = 'icon-button'; remove.title = 'Remove from watchlist'; remove.setAttribute('aria-label', `Remove ${title.textContent}`); remove.textContent = '×';
    remove.addEventListener('click', async () => { try { watchPaths = await window.profileMap.favoriteRemove(root); watchStatuses.delete(root); watchProfiles.delete(root); renderWatchlist(); updateFavoriteButton(); } catch (error) { showError(error); } });
    actions.append(badge, open, refresh, remove); item.append(left, actions); $('watch-items').append(item);
  }
  updateFavoriteButton();
}

async function refreshWatchProfile(root) {
  try { watchProfiles.set(root, await window.profileMap.inspect(root)); }
  catch { watchProfiles.set(root, null); }
  renderWatchlist();
}

function updateFavoriteButton() {
  if (!current) return;
  $('favorite').textContent = watchPaths.includes(current.root) ? '★ Saved to watchlist' : '☆ Save to watchlist';
}

async function checkOne(root, kind = 'read') {
  if (checking.has(root)) return;
  checking.add(root); renderWatchlist();
  if (current?.root === root) { text('connection-title', 'Checking…'); text('connection-detail', 'Contacting the configured remote without an interactive prompt.'); }
  try {
    const result = await window.profileMap.checkConnection(root, kind);
    watchStatuses.set(root, result);
    if (current?.root === root) showConnection(result);
  } catch (error) {
    const status = { state: 'attention', title: 'Repository unavailable', detail: error.message || String(error), checkedAt: new Date().toISOString() };
    watchStatuses.set(root, status);
    if (current?.root === root) showConnection(status);
  } finally { checking.delete(root); renderWatchlist(); }
}

function showConnection(status) {
  const panel = document.querySelector('.connection-panel');
  panel.dataset.state = status.state;
  text('connection-title', status.title);
  text('connection-detail', status.detail);
  text('connection-time', formatTime(status));
}

async function checkAll() {
  $('refresh-all').disabled = true;
  try {
    const queue = [...watchPaths];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) await checkOne(queue.shift());
    }));
  } finally { $('refresh-all').disabled = false; }
}

function addOrigin(label, value) {
  const row = document.createElement('div');
  row.className = 'origin-row';
  const name = document.createElement('strong');
  const detail = document.createElement('span');
  name.textContent = label;
  detail.textContent = value;
  row.append(name, detail);
  $('origins').append(row);
}

async function render(folder) {
  clearError();
  const data = await window.profileMap.inspect(folder);
  current = data;
  if (watchPaths.includes(data.root)) watchProfiles.set(data.root, data);
  updateFavoriteButton();
  $('path').value = data.root;
  text('path-hint', 'Folder resolved');
  text('repo-name', data.root.split(/[\\/]/).filter(Boolean).at(-1));
  text('repo-path', data.root);
  text('identity-name', data.name?.value || 'No name set');
  text('identity-email', data.email?.value || 'No email set');
  text('identity-source', `Name: ${data.name?.scope || 'unset'} · Email: ${data.email?.scope || 'unset'}`);
  const method = data.remote.method;
  text('auth-method', ({ ssh: 'SSH', https: 'HTTPS', local: 'Local path', none: 'No origin remote' })[method]);
  text('remote-url', data.origin?.value || 'No origin configured');
  text('auth-detail', method === 'https' ? `Credential helper: ${data.credentialHelper?.value || 'not configured'}` : data.coreSshCommand ? `SSH command override: ${data.coreSshCommand.value}` : sourceName(data.origin));
  text('ssh-host', method === 'ssh' ? data.remote.host : 'Not in use');
  text('ssh-target', data.ssh?.hostname ? `${data.ssh.user}@${data.ssh.hostname}` : 'This remote does not use SSH');
  text('ssh-key', data.ssh?.identityFiles?.length ? `Identity: ${data.ssh.identityFiles.join(', ')}` : 'No SSH identity resolved');
  $('origins').replaceChildren();
  addOrigin('Commit name', sourceName(data.name));
  addOrigin('Commit email', sourceName(data.email));
  addOrigin('Origin remote', sourceName(data.origin));
  if (data.pushUrl) addOrigin('Push URL', `${data.pushUrl.value} · ${sourceName(data.pushUrl)}`);
  if (data.credentialHelper) addOrigin('Credential helper', sourceName(data.credentialHelper));
  if (data.coreSshCommand) addOrigin('SSH command', sourceName(data.coreSshCommand));
  for (const include of data.conditionalIncludes) addOrigin('Folder rule', include.rule);
  $('new-name').value = data.name?.value || '';
  $('new-email').value = data.email?.value || '';
  const found = await window.profileMap.profiles();
  const select = $('new-host');
  select.replaceChildren(new Option('Keep current remote', ''));
  const remoteHost = method === 'ssh' ? data.ssh?.hostname : method === 'https' ? data.remote.host : null;
  for (const host of found.sshHosts.filter(host => found.hostTargets[host] === remoteHost)) select.add(new Option(host, host));
  select.disabled = !remoteHost || select.options.length === 1;
  text('host-help', !remoteHost ? 'Add an SSH or HTTPS origin to use a host profile.' : select.options.length === 1 ? 'No SSH profile for this Git host yet. Create one from the sidebar.' : method === 'https' ? 'Selecting a profile will convert this repository’s HTTPS origin to SSH when you confirm.' : 'Select an SSH host profile for this repository’s origin.');
  $('nav-repository').classList.remove('hidden');
  showView('repository');
  if (data.embeddedSecret) showError(new Error('This remote URL contains a password or token. Anyone who can read .git/config can see it. Switch to an HTTPS or SSH profile to move it out of the URL.'));
  const savedStatus = watchStatuses.get(data.root);
  if (savedStatus) showConnection(savedStatus);
  else { document.querySelector('.connection-panel').dataset.state = 'unchecked'; text('connection-title', 'Not checked yet'); text('connection-detail', 'Check whether Git can reach this remote without asking for credentials.'); $('connection-time').textContent = ''; }
}

$('nav-watchlist').addEventListener('click', () => showView('watchlist'));
$('nav-new-profile').addEventListener('click', () => showView('new-profile'));
$('nav-overview').addEventListener('click', () => showView('overview'));
$('nav-repository').addEventListener('click', () => { if (current) showView('repository'); });
$('back-overview').addEventListener('click', () => showView('overview'));
$('create-profile').addEventListener('click', async () => {
  clearError();
  $('create-profile').disabled = true;
  try {
    createdProfile = await window.profileMap.createSshProfile({ provider: $('setup-provider').value, alias: $('setup-alias').value, email: $('setup-email').value, passphrase: $('setup-passphrase').value });
    $('setup-passphrase').value = '';
    text('created-profile-name', createdProfile.alias);
    $('created-public-key').value = createdProfile.publicKey;
    $('setup-form').classList.add('hidden');
    $('setup-complete').classList.remove('hidden');
  } catch (error) { showError(error); }
  finally { $('create-profile').disabled = false; }
});
$('copy-public-key').addEventListener('click', async () => { if (createdProfile) { await window.profileMap.copyPublicKey(createdProfile.publicKey); $('copy-public-key').textContent = 'Copied'; } });
$('open-key-settings').addEventListener('click', async () => { if (createdProfile) { try { await window.profileMap.openKeySettings(createdProfile.keyUrl); } catch (error) { showError(error); } } });
$('another-profile').addEventListener('click', () => { createdProfile = null; $('setup-alias').value = ''; $('setup-email').value = ''; $('setup-form').classList.remove('hidden'); $('setup-complete').classList.add('hidden'); $('copy-public-key').textContent = 'Copy public key'; });
$('favorite').addEventListener('click', async () => {
  if (!current) return;
  try {
    watchPaths = watchPaths.includes(current.root) ? await window.profileMap.favoriteRemove(current.root) : await window.profileMap.favoriteAdd(current.root);
    renderWatchlist();
    if (watchPaths.includes(current.root)) { watchProfiles.set(current.root, current); renderWatchlist(); checkOne(current.root); }
  } catch (error) { showError(error); }
});
$('refresh-all').addEventListener('click', checkAll);
$('check-remote').addEventListener('click', () => { if (current) checkOne(current.root); });
$('check-push').addEventListener('click', () => { if (current) checkOne(current.root, 'push'); });
window.profileMap.favorites().then(paths => { watchPaths = paths; renderWatchlist(); for (const root of paths) refreshWatchProfile(root); checkAll(); }).catch(showError);
setInterval(() => { if (!document.hidden && watchPaths.length) checkAll(); }, 5 * 60 * 1000);

$('browse').addEventListener('click', async () => { const folder = await window.profileMap.pickFolder(); if (folder) { $('path').value = folder; try { await render(folder); } catch (error) { showError(error); } } });
$('inspect').addEventListener('click', async () => { try { await render($('path').value); } catch (error) { showError(error); } });
$('path').addEventListener('keydown', event => { if (event.key === 'Enter') $('inspect').click(); });
$('preview').addEventListener('click', async () => {
  try {
    clearError();
    proposed = { name: $('new-name').value, email: $('new-email').value, sshHost: $('new-host').value, expectedRoot: current.root, expectedRemote: current.origin?.value || '' };
    const preview = await window.profileMap.preview(current.root, proposed);
    if (!preview.changes.length) { $('notice').textContent = 'These settings are already in effect.'; $('notice').classList.remove('hidden'); return; }
    $('changes').replaceChildren();
    for (const item of preview.changes) {
      const row = document.createElement('div'); row.className = 'change';
      const label = document.createElement('strong'); label.textContent = item.label;
      const from = document.createElement('span'); from.className = 'from'; from.textContent = `Current: ${item.from}`;
      const to = document.createElement('span'); to.className = 'to'; to.textContent = `New: ${item.to}`;
      row.append(label, from, to); $('changes').append(row);
    }
    $('modal').classList.remove('hidden');
  } catch (error) { showError(error); }
});
const close = () => $('modal').classList.add('hidden');
$('close').addEventListener('click', close);
$('cancel').addEventListener('click', close);
$('modal').addEventListener('click', event => { if (event.target === $('modal')) close(); });
$('apply').addEventListener('click', async () => {
  $('apply').disabled = true;
  try { await window.profileMap.apply(current.root, proposed); close(); await render(current.root); }
  catch (error) { close(); showError(error); }
  finally { $('apply').disabled = false; }
});
