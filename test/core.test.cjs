const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const core = require('../src/core.cjs');
const { createFavorites } = require('../src/favorites.cjs');

test('recognizes SSH and HTTPS remotes', () => {
  assert.equal(core.parseRemote('https://github.com/example/repo.git').method, 'https');
  assert.deepEqual(core.parseRemote('git@github-work:example/repo.git'), { method: 'ssh', user: 'git', host: 'github-work', repoPath: 'example/repo.git', style: 'scp' });
});

test('previews converting an HTTPS origin to a selected SSH profile', () => {
  const current = { root: '/repo', name: { value: 'Work' }, email: { value: 'work@example.com' }, origin: { value: 'https://github.com/owner/repo.git' }, remote: core.parseRemote('https://github.com/owner/repo.git') };
  const preview = core.switchPreview(current, { name: 'Work', email: 'work@example.com', sshHost: 'github-work' });
  assert.equal(preview.newRemote, 'git@github-work:owner/repo.git');
  assert.equal(preview.changes.length, 1);
});

test('saves and removes watched repositories without duplicates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-profile-watch-'));
  const store = createFavorites(path.join(dir, 'saved.json'));
  try {
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.add('/repo/one'), ['/repo/one']);
    assert.deepEqual(await store.add('/repo/one'), ['/repo/one']);
    assert.deepEqual(await store.add('/repo/two'), ['/repo/one', '/repo/two']);
    assert.deepEqual(await store.remove('/repo/one'), ['/repo/two']);
    assert.deepEqual(await createFavorites(path.join(dir, 'saved.json')).list(), ['/repo/two']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reports authentication and network failures distinctly', () => {
  assert.equal(core.classifyProbe({ ok: false, output: 'Permission denied (publickey).' }, 'read').title, 'SSH authentication failed');
  assert.equal(core.classifyProbe({ ok: false, output: 'Host key verification failed.' }, 'read').title, 'SSH host trust needs attention');
  assert.equal(core.classifyProbe({ ok: false, output: 'Could not resolve hostname github.com' }, 'read').state, 'unavailable');
  assert.equal(core.classifyProbe({ ok: true, output: '' }, 'push').title, 'Push dry run passed');
});

test('checks a local remote and a dry-run push without writing commits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-profile-check-'));
  const work = path.join(dir, 'work');
  const bare = path.join(dir, 'remote.git');
  const { mkdir, writeFile } = require('node:fs/promises');
  try {
    await mkdir(work);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', '--local', 'user.name', 'Test');
    git('config', '--local', 'user.email', 'test@example.com');
    await writeFile(path.join(work, 'README'), 'test');
    git('add', 'README');
    git('commit', '-q', '-m', 'Initial');
    git('remote', 'add', 'origin', bare);
    assert.equal((await core.checkConnection(work, 'read')).state, 'healthy');
    assert.equal((await core.checkConnection(work, 'push')).state, 'healthy');
    assert.equal(spawnSync('git', ['--git-dir', bare, 'show-ref'], { encoding: 'utf8' }).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('inspects and changes only repository local identity and SSH remote', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-profile-map-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', '--local', 'user.name', 'Before');
    git('config', '--local', 'user.email', 'before@example.com');
    git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
    const before = await core.inspect(dir);
    assert.equal(before.name.value, 'Before');
    assert.equal(before.name.scope, 'local');
    assert.equal(before.remote.method, 'ssh');
    const preview = core.switchPreview(before, { name: 'After', email: 'after@example.com' });
    assert.equal(preview.changes.length, 2);
    const after = await core.applySwitch(dir, { name: 'After', email: 'after@example.com', expectedRoot: before.root, expectedRemote: before.origin.value });
    assert.equal(after.name.value, 'After');
    assert.equal(after.email.value, 'after@example.com');
    assert.equal(git('remote', 'get-url', 'origin'), 'git@github.com:owner/repo.git');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
