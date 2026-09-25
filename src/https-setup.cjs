const os = require('node:os');
const { spawn } = require('node:child_process');
const { providers } = require('./providers.cjs');
const { readJsonArray, writeJsonAtomic } = require('./json-file.cjs');

function git(args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
    let stdout = '', stderr = '';
    // If git exits before reading its input, the write fails with EPIPE; the exit code already reports that.
    child.stdin?.on('error', () => {});
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error.code === 'ENOENT' ? new Error('git is not installed or is not on PATH.') : error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(Object.assign(new Error(stderr.trim() || `git exited with ${code}`), { code })); });
    child.stdin?.end(input);
  });
}

async function credentialHelper(home) {
  try { return await git(['config', '--get', 'credential.helper'], { cwd: home }); }
  catch { return null; }
}

// Hands the token to the user's own credential helper (Keychain, Credential Manager, libsecret)
// over stdin. The app never writes the token anywhere itself.
async function storeToken(hostname, username, token, home) {
  const helper = await credentialHelper(home);
  if (!helper) throw new Error('Git has no credential helper configured, so the token could not be saved. Set one up (for example osxkeychain or Git Credential Manager) and try again.');
  await git(['credential', 'approve'], { cwd: home, input: `protocol=https\nhost=${hostname}\nusername=${username}\npassword=${token}\n\n` });
  return helper;
}

function createHttpsProfiles(file, home = os.homedir()) {
  const list = async () => (await readJsonArray(file, 'Could not read the saved HTTPS profiles.'))
    .filter(item => item && typeof item.host === 'string' && typeof item.username === 'string');
  return {
    list,
    async create(request) {
      const provider = providers[request.provider];
      const username = String(request.username || '').trim();
      const token = String(request.token || '');
      if (!provider) throw new Error('Choose a Git hosting service.');
      if (!/^[a-zA-Z0-9._@+-]{1,100}$/.test(username)) throw new Error('Enter the account username (letters, numbers, dots, underscores, hyphens, plus signs or @).');
      if (/[\r\n\0]/.test(token)) throw new Error('The token cannot contain line breaks.');
      const id = `${provider.hostname}:${username}`;
      const items = await list();
      if (items.some(item => item.id === id)) throw new Error(`An HTTPS profile for ${username} on ${provider.label} already exists.`);
      const helper = token ? await storeToken(provider.hostname, username, token, home) : null;
      const profile = { id, provider: request.provider, host: provider.hostname, username };
      await writeJsonAtomic(file, [...items, profile]);
      return { profile, tokenSaved: Boolean(token), helper, tokenUrl: provider.tokenUrl };
    },
    async remove(id) {
      return writeJsonAtomic(file, (await list()).filter(item => item.id !== id));
    }
  };
}

module.exports = { createHttpsProfiles };
