// Minimal JSON-file datastore with serialized atomic writes.
// Swappable for SQLite later without touching the rest of the app.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function emptyDb() {
  return {
    users: [],
    settings: {},
    accounts: [],
    associates: [],
    entries: [], // one row per account+month
    meta: { createdAt: new Date().toISOString() },
  };
}

let cache = null;
let writeChain = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // forward-compat: make sure all collections exist
    const base = emptyDb();
    for (const k of Object.keys(base)) if (cache[k] === undefined) cache[k] = base[k];
  } else {
    cache = emptyDb();
  }
  return cache;
}

// Atomic write (temp file + rename), serialized so concurrent requests never corrupt the file.
function persist() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeChain = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        ensureDir();
        const tmp = DB_FILE + '.' + process.pid + '.tmp';
        fs.writeFile(tmp, snapshot, (err) => {
          if (err) return reject(err);
          fs.rename(tmp, DB_FILE, (err2) => (err2 ? reject(err2) : resolve()));
        });
      })
  );
  return writeChain;
}

function get() {
  return load();
}

async function save() {
  await persist();
}

function reset() {
  cache = emptyDb();
  return persist();
}

// Simple incrementing id helper
function nextId(collection) {
  const db = load();
  const arr = db[collection] || [];
  return arr.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}

module.exports = { get, save, reset, nextId, DB_FILE };
