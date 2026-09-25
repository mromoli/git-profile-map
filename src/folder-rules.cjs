const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { run, sshResolution } = require('./core.cjs');
const { readSshHosts } = require('./ssh-config.cjs');

// A folder rule is one `[includeIf "gitdir:<folder>/"] path = <file>` line in the global Git config.
// The included file belongs to this app and holds the identity and sign-in for that folder, so
// every repository inside it, including ones cloned later, uses the same account. A repository's
// own local config still wins over it.

const conditionFolder = condition => condition.match(/^gitdir(?:\/i)?:(.+)$/)?.[1] || null;
const slash = value => value.replaceAll('\\', '/');

function createFolderRules({ home = os.homedir(), listHttpsProfiles = async () => [], resolveSshHost = async alias => (await sshResolution(alias))?.hostname || null } = {}) {
  const ruleDir = path.join(home, '.config', 'git-profile-map', 'folders');
  const expand = value => value.replace(/^~(?=$|[\\/])/, home);
  // Paths are written absolute: Git expands ~ from its own HOME, which is not always this home.
  const folderOf = condition => { const folder = conditionFolder(condition); return folder && path.resolve(expand(folder)); };
  const git = (args, cwd = home) => run('git', args, cwd);
  const isManaged = file => path.dirname(file) === ruleDir;

  async function fileSettings(file) {
    let out;
    try { out = await git(['config', '--file', file, '--null', '--list']); }
    catch { return { exists: false, entries: [] }; }
    const entries = out.split('\0').filter(Boolean).map(item => { const at = item.indexOf('\n'); return [item.slice(0, at), item.slice(at + 1)]; });
    const get = key => entries.find(([k]) => k === key)?.[1];
    const alias = entries.find(([k]) => /^url\.git@.+:\.insteadof$/.test(k))?.[0].slice('url.git@'.length, -':.insteadof'.length);
    const credential = entries.find(([k]) => /^credential\.https:\/\/.+\.username$/.test(k));
    const target = alias ? { type: 'ssh', value: alias, host: entries.find(([k]) => k === `url.git@${alias}:.insteadof`)[1].replace(/^git@|:$/g, '') }
      : credential ? { type: 'https', value: credential[1], host: credential[0].slice('credential.https://'.length, -'.username'.length) } : null;
    return { exists: true, entries, name: get('user.name') || null, email: get('user.email') || null, target };
  }

  // Every gitdir folder rule in the global config. Rules written by hand are listed too, read-only.
  async function list() {
    let out;
    try { out = await git(['config', '--global', '--null', '--show-origin', '--get-regexp', '^includeif\\.gitdir(/i)?:.*\\.path$']); }
    catch { return []; }
    const parts = out.split('\0');
    const rules = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const source = parts[i].replace(/^file:/, '');
      const at = parts[i + 1].indexOf('\n');
      const key = parts[i + 1].slice(0, at), value = parts[i + 1].slice(at + 1);
      const condition = key.slice('includeif.'.length, -'.path'.length);
      const expanded = expand(value);
      const file = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(path.dirname(source), expanded);
      rules.push({ condition, folder: folderOf(condition), value, file, source, managed: isManaged(file), ...await fileSettings(file) });
    }
    return rules.map(({ entries, ...rule }) => rule);
  }

  async function resolveTarget(target) {
    if (!target?.value) return null;
    if (target.type === 'ssh') {
      const alias = String(target.value);
      if (!(await readSshHosts(home)).includes(alias)) throw new Error('Choose an SSH host defined in ~/.ssh/config.');
      const host = await resolveSshHost(alias);
      if (!host) throw new Error(`Could not work out which Git host ${alias} connects to.`);
      if (host === alias) throw new Error(`${alias} is the host name itself, so there is nothing to redirect. Choose a named profile such as github-work.`);
      return { type: 'ssh', value: alias, host };
    }
    if (target.type === 'https') {
      const profile = (await listHttpsProfiles()).find(item => item.id === target.value);
      if (!profile) throw new Error('Choose a saved HTTPS profile.');
      return { type: 'https', value: profile.username, host: profile.host };
    }
    throw new Error('Unknown sign-in method.');
  }

  // Config lines for the rule file. An SSH profile rewrites plain SSH remotes for its host to its
  // alias, so clones like git@github.com:team/repo.git use the profile's key without being edited.
  const settingsFor = (name, email, target) => [
    ['user.name', name], ['user.email', email],
    ...target?.type === 'ssh' ? [[`url.git@${target.value}:.insteadOf`, `git@${target.host}:`], [`url.git@${target.value}:.insteadOf`, `ssh://git@${target.host}/`]] : [],
    ...target?.type === 'https' ? [[`credential.https://${target.host}.username`, target.value]] : []
  ];
  const targetLabel = target => !target ? '(none)' : target.type === 'ssh' ? `${target.value} (SSH, for git@${target.host} remotes)` : `${target.value} on ${target.host} (HTTPS)`;

  async function preview(request) {
    const raw = String(request.folder || '').trim();
    if (!raw) throw new Error('Choose a folder.');
    // gitdir patterns are globs, so these characters would match other folders too.
    if (/[\r\n\0*?[\]"]/.test(raw)) throw new Error('Folder rules can’t use folders whose path contains * ? [ ] or quotes.');
    const folder = path.resolve(expand(raw));
    if (!(await fs.stat(folder).catch(() => null))?.isDirectory()) throw new Error('That folder does not exist.');
    if (path.dirname(folder) === folder || folder === home) throw new Error('Choose a specific folder, not your home or root folder.');
    const name = String(request.name || '').trim();
    const email = String(request.email || '').trim();
    if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a name and a valid email address.');
    if (/[\r\n\0]/.test(name)) throw new Error('The name cannot contain line breaks.');
    const target = await resolveTarget(request.target);
    const condition = `gitdir:${slash(folder)}/`;
    const existing = (await list()).filter(rule => rule.folder === folder);
    const manual = existing.find(rule => !rule.managed);
    if (manual) throw new Error(`This folder already has a rule in ${manual.source} that this app didn’t create. Edit it there.`);
    const current = existing[0];
    const id = crypto.createHash('sha256').update(condition).digest('hex').slice(0, 8);
    const file = current?.file || path.join(ruleDir, `${path.basename(folder).replace(/[^a-zA-Z0-9._-]/g, '-')}-${id}.gitconfig`);
    const changes = [
      !current && { label: 'Global Git config', from: '(no rule)', to: `includeIf "${condition}" → ${slash(file)}` },
      { label: 'Commit name', from: current?.name, to: name },
      { label: 'Commit email', from: current?.email, to: email },
      { label: 'Sign-in profile', from: current ? targetLabel(current.target) : undefined, to: targetLabel(target) }
    ].filter(change => change && (change.from ?? '(unset)') !== change.to).map(change => ({ ...change, from: change.from ?? '(unset)' }));
    return { condition: current?.condition || condition, folder, file, isNew: !current, changes, settings: settingsFor(name, email, target) };
  }

  async function writeRuleFile(file, settings) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, '# Written by Git Profile Map for a folder rule in your global Git config. Edit it in the app.\n');
      for (const [key, value] of settings) await git(['config', '--file', temp, '--add', key, value]);
      await fs.rename(temp, file);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }

  async function apply(request) {
    const plan = await preview(request);
    const previous = await fs.readFile(plan.file, 'utf8').catch(() => null);
    await writeRuleFile(plan.file, plan.settings);
    if (plan.isNew) {
      try { await git(['config', '--global', '--add', `includeIf.${plan.condition}.path`, slash(plan.file)]); }
      catch (error) {
        if (previous == null) await fs.unlink(plan.file).catch(() => {});
        else await fs.writeFile(plan.file, previous).catch(() => {});
        throw new Error(`Could not add the folder rule to your global Git config: ${error.message}`);
      }
    }
    return list();
  }

  async function remove(condition) {
    const rule = (await list()).find(item => item.condition === condition && item.managed);
    if (!rule) throw new Error('This folder rule was not created by this app, so it can’t be removed here.');
    await git(['config', '--global', '--fixed-value', '--unset-all', `includeIf.${rule.condition}.path`, rule.value]);
    await fs.unlink(rule.file).catch(() => {});
    return list();
  }

  return { list, preview, apply, remove };
}

module.exports = { createFolderRules };
