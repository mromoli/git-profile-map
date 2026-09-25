const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createSshProfile } = require('../src/ssh-setup.cjs');
const { readSshHosts } = require('../src/ssh-config.cjs');

test('creates a separate key and appends a named SSH profile without replacing existing config', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-ssh-'));
  try {
    const sshDir = path.join(home, '.ssh');
    await fs.mkdir(sshDir);
    await fs.writeFile(path.join(sshDir, 'config'), 'Host existing\n  HostName example.com\n');
    const result = await createSshProfile({ provider: 'github', alias: 'github-work', email: 'work@example.com', passphrase: '' }, home);
    assert.match(result.publicKey, /^ssh-ed25519 /);
    const config = await fs.readFile(path.join(sshDir, 'config'), 'utf8');
    assert.match(config, /^Host existing\n  HostName example.com/m);
    assert.match(config, /Host github-work\n  HostName github.com\n  User git\n/);
    assert.equal((await fs.stat(path.join(sshDir, 'id_ed25519_github-work'))).mode & 0o777, 0o600);
    await assert.rejects(createSshProfile({ provider: 'github', alias: 'github-work', email: 'work@example.com' }, home), /already exists/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('places a new profile ahead of catch-all blocks so its key is tried first', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-ssh-'));
  try {
    const sshDir = path.join(home, '.ssh');
    await fs.mkdir(sshDir);
    const configFile = path.join(sshDir, 'config');
    await fs.writeFile(configFile, 'Host existing\n  HostName example.com\n\nHost *\n  IdentityFile ~/.ssh/id_default\n');
    await createSshProfile({ provider: 'github', alias: 'github-work', email: 'work@example.com', passphrase: '' }, home);
    const config = await fs.readFile(configFile, 'utf8');
    assert.ok(config.indexOf('Host github-work') < config.indexOf('Host *'));
    const resolved = execFileSync('ssh', ['-G', '-F', configFile, 'github-work'], { encoding: 'utf8' });
    const keys = [...resolved.matchAll(/^identityfile (.+)$/gm)].map(m => m[1]);
    assert.match(keys[0], /id_ed25519_github-work$/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('protects a new key with the passphrase without passing it as an argument', { skip: process.platform === 'win32' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-ssh-'));
  try {
    await createSshProfile({ provider: 'gitlab', alias: 'gitlab-work', email: 'work@example.com', passphrase: 'correct horse' }, home);
    const key = path.join(home, '.ssh', 'id_ed25519_gitlab-work');
    assert.match(execFileSync('ssh-keygen', ['-y', '-P', 'correct horse', '-f', key], { encoding: 'utf8' }), /^ssh-ed25519 /);
    assert.throws(() => execFileSync('ssh-keygen', ['-y', '-P', '', '-f', key], { stdio: 'pipe' }));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('reads host aliases from included files and ignores comments and wildcards', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-ssh-'));
  try {
    const sshDir = path.join(home, '.ssh');
    await fs.mkdir(path.join(sshDir, 'config.d'), { recursive: true });
    await fs.writeFile(path.join(sshDir, 'config'), 'Include config.d/*\nHost personal # my account\n  HostName github.com\nHost *.internal !skip\n');
    await fs.writeFile(path.join(sshDir, 'config.d', 'work'), 'Host work-gh\n  HostName github.com\n');
    assert.deepEqual((await readSshHosts(home)).sort(), ['personal', 'work-gh']);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
