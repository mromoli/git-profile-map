const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

const providers = {
  github: { hostname: 'github.com', keyUrl: 'https://github.com/settings/ssh/new' },
  gitlab: { hostname: 'gitlab.com', keyUrl: 'https://gitlab.com/-/user_settings/ssh_keys' },
  bitbucket: { hostname: 'bitbucket.org', keyUrl: 'https://bitbucket.org/account/settings/ssh-keys/' }
};

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
  const aliases = [...config.matchAll(/^\s*Host\s+(.+)$/gmi)].flatMap(match => match[1].split(/\s+/));
  if (aliases.includes(alias)) throw new Error('This SSH profile name already exists. Choose another name.');
  if (await fs.stat(keyFile).catch(() => null) || await fs.stat(`${keyFile}.pub`).catch(() => null))
    throw new Error('A key with this profile name already exists. Choose another name.');
  let generated = false;
  try {
    await runFile('ssh-keygen', ['-q', '-t', 'ed25519', '-C', email, '-f', keyFile, '-N', passphrase], { timeout: 20000, windowsHide: true });
    generated = true;
    const block = `Host ${alias}\n  HostName ${provider.hostname}\n  User git\n  IdentityFile ${keyFile}\n  IdentitiesOnly yes\n`;
    await fs.appendFile(configFile, `${config && !config.endsWith('\n') ? '\n' : ''}${config ? '\n' : ''}${block}`, { mode: 0o600 });
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
