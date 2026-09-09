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

// ---------------------------------------------------------------------------
// FIRESTORE mode (user, 2026-09-09)
// ---------------------------------------------------------------------------
// A free, persistent, non-SQL datastore (Firebase Firestore, Spark plan). It
// takes PRECEDENCE over both MySQL and the local file store when configured, so
// data survives Railway redeploys (which wipe the container's local disk).
// Configure with EITHER:
//   FIREBASE_SERVICE_ACCOUNT = the whole service-account JSON (or base64 of it)
// OR the three fields:
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
// OR set DB_DRIVER=firestore and rely on GOOGLE_APPLICATION_CREDENTIALS / ADC.
// The whole store lives as ONE document per collection in a `kv_store`
// Firestore collection — exactly mirroring the MySQL kv_store layout below.
const FIRESTORE_MODE =
  String(process.env.DB_DRIVER || '').toLowerCase() === 'firestore' ||
  /^(1|true|yes|on)$/i.test(process.env.FIRESTORE || '') ||
  !!(process.env.FIREBASE_SERVICE_ACCOUNT ||
     (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY));

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

// ---- Firestore state ----
let fsDb = null;      // Firestore instance
let fsApp = null;     // the initialised app (so scripts can delete it to exit)
let fsFieldValue = null;

// The Firestore collection that holds one document per top-level KEY.
function firestoreCollection() { return process.env.FIRESTORE_COLLECTION || 'kv_store'; }

// Build a service-account credential from the environment. Supports the whole
// JSON pasted into one variable (optionally base64-encoded), or the three
// individual fields (with escaped "\n" in the private key un-escaped — the usual
// Railway/Heroku gotcha). Returns null to fall back to application-default creds.
function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      try {
        return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
      } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON (or base64-encoded JSON)');
      }
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

function initFirestoreApp() {
  const { initializeApp, getApps, getApp, cert, applicationDefault } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  if (getApps().length) {
    fsApp = getApp();
  } else {
    const sa = loadServiceAccount();
    fsApp = initializeApp(sa ? { credential: cert(sa) } : { credential: applicationDefault() });
  }
  fsDb = getFirestore(fsApp);
  fsFieldValue = FieldValue;
}

// Parse a MySQL connection URL (mysql://user:pass@host:port/dbname) into parts.
// Railway/other PaaS often expose the database only as a single URL variable.
function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: decodeURIComponent(u.hostname),
      port: u.port ? Number(u.port) : null,
      user: u.username ? decodeURIComponent(u.username) : null,
      password: u.password ? decodeURIComponent(u.password) : null,
      database: u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : null,
    };
  } catch {
    return {};
  }
}

// Resolve the MySQL connection from (in priority order):
//   1. explicit DB_* variables (Hostinger / .env / this app's own names)
//   2. Railway's MYSQL* service variables
//   3. a single connection URL (DATABASE_URL / MYSQL_URL / DB_URL)
// so the same code runs on a hand-configured VPS and on Railway unchanged.
function dbConfig() {
  const url =
    process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.DB_URL;
  const u = url ? parseDbUrl(url) : {};
  return {
    host: process.env.DB_HOST || process.env.MYSQLHOST || u.host || 'localhost',
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || u.port || 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER || u.user || 'root',
    password:
      process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || u.password || '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || u.database || 'bngm',
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
  if (FIRESTORE_MODE) {
    initFirestoreApp();
    const snap = await fsDb.collection(firestoreCollection()).get();
    const loaded = {};
    snap.forEach((doc) => {
      const d = doc.data();
      if (d && typeof d.v === 'string') {
        try { loaded[doc.id] = JSON.parse(d.v); } catch { /* skip a corrupt doc */ }
      }
    });
    const base = emptyDb();
    for (const k of KEYS) if (loaded[k] !== undefined) base[k] = loaded[k];
    cache = base;
    console.log(`✓ Firestore connected — store loaded from "${firestoreCollection()}" collection.`);
    return cache;
  }
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
  if (FIRESTORE_MODE) {
    // Serialise each collection to JSON and upsert all six documents in one
    // atomic batch, serialised through writeChain so overlapping saves never
    // interleave — exactly like the MySQL transaction path.
    const snapshot = {};
    const base = emptyDb();
    for (const k of KEYS) snapshot[k] = JSON.stringify(cache[k] !== undefined ? cache[k] : base[k]);
    writeChain = writeChain.then(async () => {
      const col = fsDb.collection(firestoreCollection());
      const batch = fsDb.batch();
      for (const k of KEYS) {
        batch.set(col.doc(k), { v: snapshot[k], updatedAt: fsFieldValue.serverTimestamp() });
      }
      await batch.commit();
    });
    return writeChain;
  }
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
  if (FIRESTORE_MODE) {
    if (fsApp) {
      const { deleteApp } = require('firebase-admin/app');
      try { await deleteApp(fsApp); } catch { /* noop */ }
      fsApp = null; fsDb = null;
    }
    return;
  }
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

// Which backend is active, for boot logging / error messages.
function driver() {
  return FIRESTORE_MODE ? 'firestore' : MEMORY_MODE ? 'file' : 'mysql';
}

module.exports = { init, get, save, reset, close, nextId, dbConfig, driver, KEYS };
