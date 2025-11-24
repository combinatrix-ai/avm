const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const AVM_HOME = process.env.AVM_HOME || path.join(os.homedir(), '.avm');
const AGENTS_DIR = path.join(AVM_HOME, 'agents');
const STATE_FILE = path.join(AVM_HOME, 'state.json');

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function readState() {
  return (await readJson(STATE_FILE, {})) || {};
}

async function writeState(patch) {
  const previous = (await readJson(STATE_FILE, {})) || {};
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(STATE_FILE, next);
}

module.exports = {
  AVM_HOME,
  AGENTS_DIR,
  STATE_FILE,
  pathExists,
  readJson,
  writeJson,
  readState,
  writeState,
};

