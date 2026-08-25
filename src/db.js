// MySQL / MariaDB datastore (Hostinger-ready).
//
// Keeps the SAME interface the rest of the app already uses:
//   db.get()            → the in-memory store object (synchronous)
//   await db.save()     → flush the whole store to MySQL
//   await db.reset()    → wipe to an empty store
//   db.nextId(coll)     → next incrementing id for a collection
//   await db.init()     → connect + load everything into memory (call ONCE at boot)
//   await db.close()    → close the connection pool (for scripts that must exit)
//
// Design: each top-level collection (users, settings, accounts, associates,
// entries, meta) is stored as one JSON row in a `kv_store` table. At boot we
// load every row into `cache`; server.js mutates that object exactly as before;
// db.save() serialises the current cache back into MySQL inside a transaction.
//
// IMPORTANT: run a SINGLE Node process (PM2 `instances: 1`). Like the previous
// JSON-file store, the whole document lives in this process's memory and is
// flushed atomically; multiple processes would overwrite each other.
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// The collections that make up the store, in a stable order.
const KEYS = ['users', 'settings', 'accounts', 'associates', 'entries', 'meta'];

// ---------------------------------------------------------------------------
// MEMORY / no-database mode (user, 2026-08-24)
// ---------------------------------------------------------------------------
// Set DB_DISABLED=true (or DB_DRIVER=memory) to run the whole app WITHOUT MySQL.
// The store then lives in a local JSON file (data/db.json) instead of the
// kv_store table. All the MySQL code below is left completely intact and simply
// skipped while this flag is on — flip the flag back off to use the database.
const MEMORY_MODE =
  /^(1|true|yes|on)$/i.test(process.env.DB_DISABLED || '') ||
  /^(1|true|yes|on)$/i.test(process.env.NO_DB || '') ||
  String(process.env.DB_DRIVER || '').toLowerCase() === 'memory';

const STORE_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');

function loadFromFile() {
  const base = emptyDb();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    for (const k of KEYS) if (loaded[k] !== undefined) base[k] = loaded[k];
  } catch {
    /* no file yet (or unreadable) → start from an empty store */
  }
  return base;
}

function saveToFile(store) {
  const out = {};
  const base = emptyDb();
  for (const k of KEYS) out[k] = store[k] !== undefined ? store[k] : base[k];
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  // Write to a temp file then rename so a crash mid-write can't corrupt the store.
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

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
let pool = null;
let writeChain = Promise.resolve();

function dbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bngm',
  };
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...dbConfig(),
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      // JSON is stored/read as text; keep everything predictable.
      dateStrings: true,
    });
  }
  return pool;
}

async function ensureSchema() {
  const p = getPool();
  await p.query(
    `CREATE TABLE IF NOT EXISTS kv_store (
       k VARCHAR(64) NOT NULL PRIMARY KEY,
       v LONGTEXT NOT NULL,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

// Connect, create the table if needed, and load the whole store into memory.
// Must be awaited before any db.get() call.
async function init() {
  if (MEMORY_MODE) {
    cache = loadFromFile();
    console.log(`⚠  DB DISABLED — running on local file store (${STORE_FILE}). No MySQL used.`);
    return cache;
  }
  await ensureSchema();
  const p = getPool();
  const [rows] = await p.query('SELECT k, v FROM kv_store');
  const loaded = {};
  for (const r of rows) {
    try {
      loaded[r.k] = JSON.parse(r.v);
    } catch {
      /* ignore a corrupt row; the emptyDb default fills in below */
    }
  }
  const base = emptyDb();
  for (const k of KEYS) if (loaded[k] !== undefined) base[k] = loaded[k];
  cache = base;
  return cache;
}

function get() {
  if (!cache) {
    throw new Error('db.init() must be awaited before db.get() (database not loaded yet)');
  }
  return cache;
}

// Serialise the current cache and upsert every collection in one transaction,
// serialised through writeChain so overlapping saves never interleave.
function persist() {
  if (MEMORY_MODE) {
    // Serialise through writeChain just like the MySQL path so overlapping saves
    // never interleave, but flush to the local JSON file instead of the database.
    const snapshot = JSON.parse(JSON.stringify(cache));
    writeChain = writeChain.then(async () => { saveToFile(snapshot); });
    return writeChain;
  }
  const snapshot = {};
  const base = emptyDb();
  for (const k of KEYS) snapshot[k] = JSON.stringify(cache[k] !== undefined ? cache[k] : base[k]);

  writeChain = writeChain.then(async () => {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      for (const k of KEYS) {
        await conn.query(
          'INSERT INTO kv_store (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
          [k, snapshot[k]]
        );
      }
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* noop */ }
      throw err;
    } finally {
      conn.release();
    }
  });
  return writeChain;
}

async function save() {
  await persist();
}

async function reset() {
  cache = emptyDb();
  await persist();
}

// Close the pool so short-lived scripts (seed/reset/db:test) can exit cleanly.
async function close() {
  if (MEMORY_MODE) return; // no pool to close in file-store mode
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Simple incrementing id helper (operates on the in-memory cache).
function nextId(collection) {
  const db = get();
  const arr = db[collection] || [];
  return arr.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}

module.exports = { init, get, save, reset, close, nextId, dbConfig, KEYS };
