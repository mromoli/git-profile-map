const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHttpsProfiles } = require('../src/https-setup.cjs');
const core = require('../src/core.cjs');

test('saves an HTTPS profile and hands the token to the configured credential helper', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-https-'));
  // Keep Git away from the real system/global helpers (e.g. the macOS Keychain) during this test.
  const saved = { nosystem: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL };
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(home, 'empty-global');
  try {
    const store = path.join(home, 'credentials');
    // Isolated from the real keychain: the store helper writes to a temp file.
    execFileSync('git', ['init', '-q', home]);
    execFileSync('git', ['config', '--local', 'credential.helper', `store --file=${store.replaceAll('\\', '/')}`], { cwd: home });
    const profiles = createHttpsProfiles(path.join(home, 'https.json'), home);
    const result = await profiles.create({ provider: 'github', username: 'test-account', token: 'fake-token-123' });
    assert.equal(result.tokenSaved, true);
    assert.deepEqual(await profiles.list(), [{ id: 'github.com:test-account', provider: 'github', host: 'github.com', username: 'test-account' }]);
    assert.equal((await fs.readFile(store, 'utf8')).trim(), 'https://test-account:fake-token-123@github.com');
    assert.doesNotMatch(await fs.readFile(path.join(home, 'https.json'), 'utf8'), /fake-token-123/);
    await assert.rejects(profiles.create({ provider: 'github', username: 'test-account' }), /already exists/);
    assert.deepEqual(await profiles.remove('github.com:test-account'), []);
  } finally {
    for (const [key, value] of [['GIT_CONFIG_NOSYSTEM', saved.nosystem], ['GIT_CONFIG_GLOBAL', saved.global]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('switches an SSH origin to an HTTPS account and back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-https-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://old-user:tok@github.com/owner/repo.git');
    const before = await core.inspect(dir);
    assert.equal(before.httpsUser, 'old-user');
    const preview = core.switchPreview(before, { name: 'Work', email: 'work@example.com', target: { type: 'https', value: 'test-account' } });
    assert.equal(preview.newRemote, 'https://github.com/owner/repo.git');
    const after = await core.applySwitch(dir, { name: 'Work', email: 'work@example.com', target: { type: 'https', value: 'test-account' }, expectedRoot: before.root, expectedRemote: before.origin.value });
    assert.equal(git('remote', 'get-url', 'origin'), 'https://github.com/owner/repo.git');
    assert.equal(git('config', '--local', 'credential.https://github.com.username'), 'test-account');
    assert.equal(after.httpsUser, 'test-account');
    assert.equal(after.embeddedSecret, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('builds HTTPS URLs from SSH remotes and keeps custom ports', () => {
  const ssh = { root: '/r', name: { value: 'A' }, email: { value: 'a@example.com' }, origin: { value: 'git@github-work:owner/repo.git' }, remote: core.parseRemote('git@github-work:owner/repo.git'), ssh: { hostname: 'github.com' } };
  assert.equal(core.switchPreview(ssh, { name: 'A', email: 'a@example.com', target: { type: 'https', value: 'me' } }).newRemote, 'https://github.com/owner/repo.git');
  const port = { ...ssh, origin: { value: 'https://git.example.com:8443/team/repo.git' }, remote: core.parseRemote('https://git.example.com:8443/team/repo.git') };
  assert.equal(core.switchPreview(port, { name: 'A', email: 'a@example.com', target: { type: 'https', value: 'me' } }).newRemote, 'https://git.example.com:8443/team/repo.git');
  assert.throws(() => core.switchPreview(ssh, { name: 'A', email: 'a@example.com', target: { type: 'https', value: 'bad user' } }), /usernames/);
});
