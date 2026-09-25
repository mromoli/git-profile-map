const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSshProfile } = require('../src/ssh-setup.cjs');

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
