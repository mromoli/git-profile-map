const fs = require('node:fs/promises');
const path = require('node:path');

async function readJsonArray(file, errorMessage) {
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(errorMessage);
  }
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  return data;
}

module.exports = { readJsonArray, writeJsonAtomic };
