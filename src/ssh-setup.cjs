const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { providers } = require('./providers.cjs');
const { readSshHosts, withHostBlock } = require('./ssh-config.cjs');
const runFile = promisify(execFile);

// Keeps the passphrase out of the process list: ssh-keygen asks a throwaway askpass script,
// which reads it from this process's environment. Windows falls back to -N.
async function generateKey(keyFile, email, passphrase) {
  const args = ['-q', '-t', 'ed25519', '-C', email, '-f', keyFile];
  if (!passphrase || process.platform === 'win32') {
    return runFile('ssh-keygen', [...args, '-N', passphrase], { timeout: 20000, windowsHide: true });
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-askpass-'));
  const askpass = path.join(dir, 'askpass');
  try {
    await fs.writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$GIT_PROFILE_MAP_PASSPHRASE"\n', { mode: 0o700 });
    return await runFile('ssh-keygen', args, { timeout: 20000, windowsHide: true,
      env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', GIT_PROFILE_MAP_PASSPHRASE: passphrase } });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function createSshProfile(request, home = os.homedir()) {
  const provider = providers[request.provider];
  const alias = String(request.alias || '').trim();
  const email = String(request.email || '').trim();
  const passphrase = String(request.passphrase || '');
  if (!provider) throw new Error('Choose a Git hosting service.');
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{1,49}$/.test(alias)) throw new Error('Profile name must start with a letter and use 2–50 letters, numbers, dots, underscores or hyphens.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter the email for this Git account.');
  if (/[\r\n\0]/.test(passphrase)) throw new Error('The passphrase cannot contain line breaks.');
  const sshDir = path.join(home, '.ssh');
  const configFile = path.join(sshDir, 'config');
  const keyFile = path.join(sshDir, `id_ed25519_${alias}`);
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  const config = await fs.readFile(configFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if ((await readSshHosts(home)).includes(alias)) throw new Error('This SSH profile name already exists. Choose another name.');
  if (await fs.stat(keyFile).catch(() => null) || await fs.stat(`${keyFile}.pub`).catch(() => null))
    throw new Error('A key with this profile name already exists. Choose another name.');
  let generated = false;
  try {
    await generateKey(keyFile, email, passphrase);
    generated = true;
    const block = `Host ${alias}\n  HostName ${provider.hostname}\n  User git\n  IdentityFile ${keyFile}\n  IdentitiesOnly yes\n`;
    // Write through symlinks (dotfile managers) instead of replacing them.
    const target = await fs.realpath(configFile).catch(() => configFile);
    const mode = (await fs.stat(target).catch(() => null))?.mode & 0o777 || 0o600;
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, withHostBlock(config, block), { mode });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (generated) {
      await fs.unlink(keyFile).catch(() => {});
      await fs.unlink(`${keyFile}.pub`).catch(() => {});
    }
    throw new Error(`Could not create the SSH profile: ${error.message}`);
  }
  return { alias, email, provider: request.provider, keyUrl: provider.keyUrl, publicKey: (await fs.readFile(`${keyFile}.pub`, 'utf8')).trim() };
}

module.exports = { createSshProfile };
