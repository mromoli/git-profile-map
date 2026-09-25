const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function stripComment(line) {
  const hash = line.search(/(^|\s)#/);
  return (hash < 0 ? line : line.slice(0, hash)).trim();
}

function directive(line) {
  const match = stripComment(line).match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
  return match ? { key: match[1].toLowerCase(), value: match[2].trim() } : null;
}

function globToRegExp(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

async function expandInclude(pattern, home) {
  const full = pattern.startsWith('~') ? path.join(home, pattern.slice(1)) : path.isAbsolute(pattern) ? pattern : path.join(home, '.ssh', pattern);
  if (!/[*?]/.test(path.basename(full))) return [full];
  const dir = path.dirname(full);
  const names = await fs.readdir(dir).catch(() => []);
  const match = globToRegExp(path.basename(full));
  return names.filter(name => match.test(name)).sort().map(name => path.join(dir, name));
}

// Named Host aliases from ~/.ssh/config and any files it includes. Wildcard patterns are skipped.
async function readSshHosts(home = os.homedir(), file = path.join(home, '.ssh', 'config'), seen = new Set()) {
  if (seen.has(file) || seen.size > 32) return [];
  seen.add(file);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const hosts = [];
  for (const line of text.split(/\r?\n/)) {
    const item = directive(line);
    if (item?.key === 'host') hosts.push(...item.value.split(/\s+/).filter(x => x && !/[?*!]/.test(x)));
    else if (item?.key === 'include') {
      for (const pattern of item.value.split(/\s+/).filter(Boolean))
        for (const included of await expandInclude(pattern, home)) hosts.push(...await readSshHosts(home, included, seen));
    }
  }
  return [...new Set(hosts)];
}

// Line index where a new Host block must go so that catch-all blocks (Host *, Match) cannot
// add their IdentityFile ahead of the new key. OpenSSH tries identity files in the order found.
function insertionLine(lines) {
  return lines.findIndex(line => {
    const item = directive(line);
    return item?.key === 'match' || (item?.key === 'host' && item.value.split(/\s+/).some(x => /[?*!]/.test(x)));
  });
}

function withHostBlock(config, block) {
  const lines = config.split('\n');
  const at = insertionLine(lines);
  if (at < 0) return `${config}${config && !config.endsWith('\n') ? '\n' : ''}${config ? '\n' : ''}${block}`;
  return [...lines.slice(0, at), ...block.replace(/\n$/, '').split('\n'), '', ...lines.slice(at)].join('\n');
}

module.exports = { readSshHosts, withHostBlock, stripComment };
