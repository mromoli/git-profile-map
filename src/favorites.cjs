const fs = require('node:fs/promises');
const path = require('node:path');

function createFavorites(file) {
  async function list() {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      return Array.isArray(saved) ? saved.filter(item => typeof item === 'string') : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Could not read the saved repositories list.');
    }
  }
  async function save(items) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o600 });
      await fs.rename(temp, file);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
    return items;
  }
  return {
    list,
    async add(root) {
      const items = await list();
      if (!items.includes(root)) {
        if (items.length >= 100) throw new Error('The watchlist is full (100 repositories).');
        items.push(root);
        await save(items);
      }
      return items;
    },
    async remove(root) {
      const items = (await list()).filter(item => item !== root);
      return save(items);
    }
  };
}

module.exports = { createFavorites };
