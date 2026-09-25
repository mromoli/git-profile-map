const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createFolderRules } = require('../src/folder-rules.cjs');
const core = require('../src/core.cjs');

// Each test gets its own home, global Git config and SSH config, so the real ones are never read or written.
async function sandbox(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-profile-folders-')));
  const home = path.join(dir, 'home');
  const globalConfig = path.join(dir, 'global.gitconfig');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host github-work\n  HostName github.com\n\nHost github-personal\n  HostName github.com\n');
  await fs.writeFile(globalConfig, '[user]\n\tname = Global Name\n\temail = global@example.com\n');
  const saved = { nosystem: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL };
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(async () => {
    for (const [key, value] of [['GIT_CONFIG_NOSYSTEM', saved.nosystem], ['GIT_CONFIG_GLOBAL', saved.global]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const work = path.join(dir, 'Work');
  await fs.mkdir(work);
  const rules = createFolderRules({ home, resolveSshHost: async alias => ({ 'github-work': 'github.com', 'github-personal': 'github.com' })[alias] || null,
    listHttpsProfiles: async () => [{ id: 'github.com:work-user', provider: 'github', host: 'github.com', username: 'work-user' }] });
  return { dir, home, globalConfig, work, rules };
}

const request = (work, target = { type: 'ssh', value: 'github-work' }) => ({ folder: work, name: 'Work Name', email: 'work@example.com', target });

test('a folder rule gives repositories inside the folder its identity and SSH profile', async t => {
  const { work, rules, globalConfig } = await sandbox(t);
  const plan = await rules.preview(request(work));
  assert.equal(plan.isNew, true);
  assert.deepEqual(plan.changes.map(x => x.label), ['Global Git config', 'Commit name', 'Commit email', 'Sign-in profile']);
  const [rule] = await rules.apply(request(work));
  assert.equal(rule.managed, true);
  assert.equal(rule.folder, work);
  assert.deepEqual(rule.target, { type: 'ssh', value: 'github-work', host: 'github.com' });
  assert.match(await fs.readFile(globalConfig, 'utf8'), /Global Name[\s\S]*\[includeIf "gitdir:/);

  const repo = path.join(work, 'app');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:team/app.git'], { cwd: repo });
  const data = await core.inspect(repo);
  assert.equal(data.name.value, 'Work Name');
  assert.equal(data.name.via.condition, rule.condition);
  assert.equal(data.origin.value, 'git@github.com:team/app.git');
  assert.equal(data.effectiveOrigin, 'git@github-work:team/app.git');
  assert.equal(data.remote.host, 'github-work');
  assert.equal(data.originRewrite.from, 'git@github.com:team/app.git');

  // A repository can still be switched to another profile; its local origin then bypasses the rule.
  const preview = core.switchPreview(data, { name: 'Me', email: 'me@example.com', sshHost: 'github-personal' });
  assert.equal(preview.newRemote, 'git@github-personal:team/app.git');

  // Outside the folder the global identity still applies.
  const outside = path.join(path.dirname(work), 'Other');
  execFileSync('git', ['init', '-q', outside]);
  assert.equal((await core.inspect(outside)).name.value, 'Global Name');
});

test('editing a rule rewrites its file without adding a second include line', async t => {
  const { work, rules, globalConfig } = await sandbox(t);
  await rules.apply(request(work));
  const plan = await rules.preview(request(work, { type: 'https', value: 'github.com:work-user' }));
  assert.equal(plan.isNew, false);
  assert.deepEqual(plan.changes, [{ label: 'Sign-in profile', from: 'github-work (SSH, for git@github.com remotes)', to: 'work-user on github.com (HTTPS)' }]);
  const [rule] = await rules.apply(request(work, { type: 'https', value: 'github.com:work-user' }));
  assert.deepEqual(rule.target, { type: 'https', value: 'work-user', host: 'github.com' });
  assert.equal((await fs.readFile(globalConfig, 'utf8')).match(/includeIf/g).length, 1);
  assert.doesNotMatch(await fs.readFile(rule.file, 'utf8'), /insteadOf/);
});

test('removing a rule deletes its include line and file and leaves the rest of the config alone', async t => {
  const { work, rules, globalConfig } = await sandbox(t);
  const [rule] = await rules.apply(request(work));
  assert.deepEqual(await rules.remove(rule.condition), []);
  assert.equal(await fs.readFile(globalConfig, 'utf8'), '[user]\n\tname = Global Name\n\temail = global@example.com\n');
  await assert.rejects(fs.stat(rule.file));
});

test('leaves hand-written folder rules alone', async t => {
  const { work, rules, globalConfig, dir } = await sandbox(t);
  await fs.writeFile(path.join(dir, 'mine.gitconfig'), '[user]\n\temail = mine@example.com\n');
  await fs.appendFile(globalConfig, `[includeIf "gitdir:${work}/"]\n\tpath = mine.gitconfig\n`);
  const [rule] = await rules.list();
  assert.equal(rule.managed, false);
  assert.equal(rule.email, 'mine@example.com');
  await assert.rejects(rules.preview(request(work)), /didn’t create/);
  await assert.rejects(rules.remove(rule.condition), /not created by this app/);
});

test('rejects unknown profiles and folders that would act as glob patterns', async t => {
  const { work, rules, dir } = await sandbox(t);
  await assert.rejects(rules.preview(request(work, { type: 'ssh', value: 'nope' })), /~\/.ssh\/config/);
  await assert.rejects(rules.preview(request(work, { type: 'https', value: 'gitlab.com:x' })), /saved HTTPS profile/);
  const glob = path.join(dir, 'a[1]');
  await fs.mkdir(glob);
  await assert.rejects(rules.preview(request(glob)), /\* \? \[ \]/);
  await assert.rejects(rules.preview(request(path.join(dir, 'missing'))), /does not exist/);
});

test('says which included file a setting came from', async t => {
  const { dir, globalConfig } = await sandbox(t);
  await fs.writeFile(path.join(dir, 'company.gitconfig'), '[user]\n\tname = Company Name\n');
  await fs.appendFile(globalConfig, '[include]\n\tpath = company.gitconfig\n');
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const data = await core.inspect(repo);
  assert.equal(data.name.scope, 'global');
  assert.equal(data.name.via.condition, null);
  assert.equal(data.name.via.includedFrom, globalConfig);
  assert.equal(data.email.via, undefined);
});
