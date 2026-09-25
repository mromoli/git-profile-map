const { readJsonArray, writeJsonAtomic } = require('./json-file.cjs');

function createFavorites(file) {
  const list = async () => (await readJsonArray(file, 'Could not read the saved repositories list.')).filter(item => typeof item === 'string');
  return {
    list,
    async add(root) {
      const items = await list();
      if (!items.includes(root)) {
        if (items.length >= 100) throw new Error('The watchlist is full (100 repositories).');
        items.push(root);
        await writeJsonAtomic(file, items);
      }
      return items;
    },
    async remove(root) {
      return writeJsonAtomic(file, (await list()).filter(item => item !== root));
    }
  };
}

module.exports = { createFavorites };
