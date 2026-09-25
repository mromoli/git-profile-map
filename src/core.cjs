const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readSshHosts } = require('./ssh-config.cjs');
const runFile = promisify(execFile);

async function run(command, args, cwd) {
  try {
    const { stdout } = await runFile(command, args, { cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${command} is not installed or is not on PATH.`);
    throw new Error((error.stderr || error.message || '').trim());
  }
}

async function probe(command, args, cwd, env = {}) {
  try {
    const result = await runFile(command, args, { cwd, env: { ...process.env, ...env }, timeout: 18000, maxBuffer: 1024 * 1024, windowsHide: true });
    return { ok: true, output: `${result.stdout}\n${result.stderr}`.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`.trim(), timedOut: error.killed || error.code === 'ETIMEDOUT' };
  }
}

function parseConfigRecord(value) {
  const parts = value.split('\0');
  if (parts.length < 3) return null;
  return { scope: parts[0], source: parts[1], value: parts[2] };
}

async function configValue(cwd, key) {
  try { return parseConfigRecord(await run('git', ['config', '--null', '--show-scope', '--show-origin', '--get', key], cwd)); }
  catch { return null; }
}

async function configList(cwd, scope) {
  const args = ['config', '--null', '--show-scope', '--show-origin'];
  if (scope) args.push(`--${scope}`);
  args.push('--list');
  try {
    const out = await run('git', args, cwd);
    const parts = out.split('\0');
    const rows = [];
    for (let i = 0; i + 2 < parts.length; i += 3) rows.push({ scope: parts[i], source: parts[i + 1], entry: parts[i + 2] });
    return rows;
  } catch { return []; }
}

function parseRemote(remote) {
  if (!remote) return { method: 'none' };
  try {
    const url = new URL(remote);
    if (url.protocol === 'ssh:') return { method: 'ssh', user: url.username || 'git', host: url.hostname, repoPath: url.pathname.replace(/^\//, ''), style: 'url' };
    if (url.protocol === 'https:' || url.protocol === 'http:')
      return { method: 'https', host: url.hostname, port: url.port, user: decodeURIComponent(url.username) || null, repoPath: url.pathname.replace(/^\//, ''), style: 'url' };
    if (url.protocol === 'file:') return { method: 'local', style: 'url' };
  } catch {}
  const scp = remote.match(/^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/);
  if (scp && !/^[a-zA-Z]:[\\/]/.test(remote)) return { method: 'ssh', user: scp[1] || 'git', host: scp[2], repoPath: scp[3], style: 'scp' };
  return { method: 'local' };
}

function parseSshG(output) {
  const map = {};
  for (const line of output.split(/\r?\n/)) {
    const split = line.indexOf(' ');
    if (split < 0) continue;
    const key = line.slice(0, split).toLowerCase();
    const value = line.slice(split + 1).trim();
    (map[key] ||= []).push(value);
  }
  return { hostname: map.hostname?.[0] || null, user: map.user?.[0] || null, identityFiles: map.identityfile || [], identitiesOnly: map.identitiesonly?.[0] === 'yes', proxyCommand: map.proxycommand?.[0] || null };
}

async function sshResolution(host) {
  if (!host) return null;
  try { return parseSshG(await run('ssh', ['-G', host])); }
  catch (error) { return { error: error.message }; }
}

// The Git host a remote really talks to (SSH aliases resolved through ssh -G).
const remoteHostname = (remote, ssh) => remote?.method === 'ssh' ? ssh?.hostname || null : remote?.method === 'https' ? remote.host : null;
// Credential helpers store logins per host and username, so this key picks the HTTPS account.
const credentialUserKey = hostname => `credential.https://${hostname}.username`;

// Hides a password or token embedded in an HTTPS remote so it never reaches the window.
function redactUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.password) { url.password = '***'; return url.toString(); }
  } catch {}
  return value;
}

const hasEmbeddedSecret = value => { try { return Boolean(new URL(value).password); } catch { return false; } };

async function inspectRaw(folder) {
  if (typeof folder !== 'string' || !folder.trim()) throw new Error('Choose a repository folder.');
  const input = path.resolve(folder.replace(/^~(?=$|[\\/])/, os.homedir()));
  const stat = await fs.stat(input).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('That folder does not exist.');
  let root;
  try { root = await run('git', ['rev-parse', '--show-toplevel'], input); }
  catch { throw new Error('This folder is not inside a Git repository.'); }
  const [name, email, origin, pushUrl, credentialHelper, coreSshCommand, entries] = await Promise.all([
    configValue(input, 'user.name'), configValue(input, 'user.email'), configValue(input, 'remote.origin.url'),
    configValue(input, 'remote.origin.pushurl'), configValue(input, 'credential.helper'),
    configValue(input, 'core.sshCommand'), configList(input)
  ]);
  const remote = parseRemote(origin?.value);
  const pushRemote = pushUrl ? parseRemote(pushUrl.value) : null;
  const [ssh, pushSsh] = await Promise.all([
    remote.method === 'ssh' ? sshResolution(remote.host) : null,
    pushRemote?.method === 'ssh' ? sshResolution(pushRemote.host) : null
  ]);
  const hostname = remoteHostname(remote, ssh);
  const credentialUser = hostname ? await configValue(input, credentialUserKey(hostname)) : null;
  const httpsUser = remote.method === 'https' ? remote.user || credentialUser?.value || null : null;
  return { root, name, email, origin, pushUrl, pushRemote, pushSsh, credentialHelper, coreSshCommand, remote, ssh, hostname, credentialUser, httpsUser,
    pushUrlCount: entries.filter(x => x.entry.startsWith('remote.origin.pushurl\n')).length,
    conditionalIncludes: entries.filter(x => x.entry.startsWith('includeif.')).map(x => ({ source: x.source, rule: x.entry })) };
}

async function inspect(folder) {
  const raw = await inspectRaw(folder);
  const redact = record => record && { ...record, value: redactUrl(record.value) };
  return { ...raw, origin: redact(raw.origin), pushUrl: redact(raw.pushUrl),
    embeddedSecret: hasEmbeddedSecret(raw.origin?.value) || hasEmbeddedSecret(raw.pushUrl?.value) };
}

async function profiles() {
  const entries = await configList(os.homedir(), 'global');
  const includes = entries.filter(x => /^include(?:if)?\./.test(x.entry));
  const sshHosts = await readSshHosts();
  const hostTargets = Object.fromEntries(await Promise.all(sshHosts.map(async host => [host, (await sshResolution(host))?.hostname || null])));
  return { sshHosts, hostTargets, includes: includes.map(x => ({ source: x.source, rule: x.entry })) };
}

function classifyProbe(result, kind) {
  const checkedAt = new Date().toISOString();
  if (result.ok) return { state: 'healthy', title: kind === 'push' ? 'Push dry run passed' : 'Remote reachable', detail: kind === 'push' ? 'Git accepted a dry-run push. Server rules may still reject a real push.' : 'Git could read the remote without prompting.', checkedAt };
  const output = result.output || '';
  if (/Permission denied \(publickey\)|no supported authentication methods|agent refused operation|sign_and_send_pubkey|Too many authentication failures/i.test(output))
    return { state: 'attention', title: 'SSH authentication failed', detail: 'The configured key was not accepted. Check whether the key is loaded in your SSH agent and registered with this host.', checkedAt };
  if (/Authentication failed|could not read Username|terminal prompts disabled|HTTP (?:Basic|401|403)|fatal: unable to access.*(?:401|403)/i.test(output))
    return { state: 'attention', title: 'HTTPS authentication failed', detail: 'The credential helper may need a new login or token.', checkedAt };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output))
    return { state: 'attention', title: 'SSH host trust needs attention', detail: 'Check the server host key before connecting again.', checkedAt };
  if (kind === 'push' && /non-fast-forward|fetch first|rejected|protected branch|permission.*denied/i.test(output))
    return { state: 'attention', title: 'Push would be rejected', detail: output.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 250), checkedAt };
  if (result.timedOut || /Could not resolve hostname|Could not resolve host|Connection timed out|Network is unreachable|Failed to connect|Connection refused/i.test(output))
    return { state: 'unavailable', title: 'Connection unavailable', detail: 'The network or remote server could not be reached. Try again when connected.', checkedAt };
  return { state: 'attention', title: kind === 'push' ? 'Push check failed' : 'Remote check failed', detail: output.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 250) || 'Git did not provide a reason.', checkedAt };
}

async function checkConnection(folder, kind = 'read') {
  if (!['read', 'push'].includes(kind)) throw new Error('Unknown connection check.');
  const data = await inspectRaw(folder);
  if (!data.origin?.value) return { state: 'attention', title: 'No origin remote', detail: 'Add an origin remote to test a connection.', checkedAt: new Date().toISOString() };
  const env = { GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' };
  if (data.remote.method === 'ssh' && !data.coreSshCommand && !process.env.GIT_SSH_COMMAND)
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=8';
  const args = kind === 'push' ? ['push', '--dry-run', 'origin', 'HEAD'] : ['ls-remote', 'origin', 'HEAD'];
  return { ...classifyProbe(await probe('git', args, data.root, env), kind), root: data.root, kind };
}


const repoPathOf = (remote, value) => {
  const repoPath = (remote.method === 'https' ? new URL(value).pathname : remote.repoPath).replace(/^[/~]+/, '');
  if (!repoPath) throw new Error('The remote has no repository path.');
  return repoPath;
};

// How each sign-in method rewrites a remote. `value` is an SSH host alias or an HTTPS username.
const transports = {
  ssh: {
    label: 'SSH host aliases can contain only letters, numbers, dots, underscores and hyphens.',
    pattern: /^[a-zA-Z0-9._-]+$/,
    url(remote, alias, value) {
      if (remote.method === 'ssh') return remote.style === 'url' ? `ssh://${remote.user}@${alias}/${remote.repoPath}` : `${remote.user}@${alias}:${remote.repoPath}`;
      return `git@${alias}:${repoPathOf(remote, value)}`;
    },
    writes: () => []
  },
  https: {
    label: 'HTTPS usernames can contain only letters, numbers, dots, underscores, hyphens, plus signs and @.',
    pattern: /^[a-zA-Z0-9._@+-]{1,100}$/,
    // The URL carries no username or token; the account comes from credential.<host>.username.
    url(remote, _user, value, hostname) {
      const port = remote.method === 'https' && remote.port ? `:${remote.port}` : '';
      return `https://${hostname}${port}/${repoPathOf(remote, value)}`;
    },
    writes: (current, user) => [{ label: 'HTTPS account', key: credentialUserKey(current.hostname), from: current.credentialUser?.scope === 'local' ? current.credentialUser.value : undefined, to: user }]
  }
};

function parseTarget(request) {
  const target = request.target || (request.sshHost ? { type: 'ssh', value: request.sshHost } : null);
  if (!target?.value) return null;
  const transport = transports[target.type];
  const value = String(target.value).trim();
  if (!transport) throw new Error('Unknown sign-in method.');
  if (!transport.pattern.test(value)) throw new Error(transport.label);
  return { type: target.type, value, transport };
}

// Each change is one local config write; `to: null` unsets the key.
function switchPreview(state, request) {
  const current = { ...state, hostname: state.hostname ?? remoteHostname(state.remote, state.ssh) };
  const name = String(request.name || '').trim();
  const email = String(request.email || '').trim();
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a name and a valid email address.');
  const target = parseTarget(request);
  if (target && !['ssh', 'https'].includes(current.remote.method)) throw new Error('This repository needs an SSH or HTTPS origin to use a sign-in profile.');
  if (target && !current.hostname) throw new Error('Could not work out which Git host this origin uses.');
  const changes = [
    { label: 'Commit name', key: 'user.name', from: current.name?.value, to: name },
    { label: 'Commit email', key: 'user.email', from: current.email?.value, to: email }
  ];
  const retarget = (remote, value) => target.transport.url(remote, target.value, value, current.hostname);
  const newRemote = target ? retarget(current.remote, current.origin.value) : current.origin?.value;
  if (target) {
    changes.push({ label: 'Origin remote', key: 'remote.origin.url', from: current.origin.value, to: newRemote });
    if (current.pushUrl) {
      if (current.pushUrlCount > 1) throw new Error('Origin has more than one push URL. Remove the extras before switching.');
      if (current.pushUrl.scope !== 'local') throw new Error(`Origin's push URL is set in ${current.pushUrl.source.replace(/^file:/, '')}. Change it there first.`);
      if (!['ssh', 'https'].includes(current.pushRemote?.method) || remoteHostname(current.pushRemote, current.pushSsh) !== current.hostname)
        throw new Error('Origin pushes to a different Git host than it fetches from. Update the push URL manually.');
      changes.push({ label: 'Push URL', key: 'remote.origin.pushurl', from: current.pushUrl.value, to: retarget(current.pushRemote, current.pushUrl.value) });
    }
    changes.push(...target.transport.writes(current, target.value));
  }
  const pending = changes.filter(x => (x.from ?? null) !== x.to);
  return { root: current.root, newRemote, name, email,
    changes: pending.map(x => ({ label: x.label, from: x.from == null ? '(unset)' : redactUrl(x.from), to: x.to ?? '(unset)' })),
    writes: pending.map(({ key, to }) => ({ key, to })) };
}

async function localGet(root, key) {
  try { return await run('git', ['config', '--local', '--get', key], root); }
  catch { return undefined; }
}

async function localSet(root, key, value) {
  if (value == null) await run('git', ['config', '--local', '--unset-all', key], root).catch(() => {});
  else await run('git', ['config', '--local', key, value], root);
}

async function applySwitch(folder, request) {
  const current = await inspectRaw(folder);
  if (request.expectedRoot !== current.root || request.expectedRemote !== (redactUrl(current.origin?.value) || ''))
    throw new Error('Repository settings changed since the preview. Refresh and try again.');
  const preview = switchPreview(current, request);
  const target = parseTarget(request);
  if (target?.type === 'ssh') {
    const known = (await profiles()).sshHosts;
    if (!known.includes(target.value)) throw new Error('Choose an SSH host defined in ~/.ssh/config.');
    const resolved = await sshResolution(target.value);
    if (!resolved?.hostname || resolved.hostname !== current.hostname)
      throw new Error('This SSH profile points to a different Git host than the repository origin.');
  }
  const applied = [];
  try {
    for (const write of preview.writes) {
      applied.push({ key: write.key, previous: await localGet(current.root, write.key) });
      await localSet(current.root, write.key, write.to);
    }
  } catch (error) {
    for (const { key, previous } of applied.reverse()) await localSet(current.root, key, previous).catch(() => {});
    throw error;
  }
  return inspect(current.root);
}

module.exports = { inspect, profiles, switchPreview, applySwitch, checkConnection, classifyProbe, parseRemote, parseSshG, redactUrl };
