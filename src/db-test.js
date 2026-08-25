// Quick connectivity check: `npm run db:test`.
// Connects with your .env settings, ensures the table exists, and reports what
// it finds. Use this on Hostinger right after setting up the database to confirm
// the credentials are right BEFORE running the seed.
try { require('dotenv').config(); } catch { /* .env optional */ }
const db = require('./db');

(async () => {
  const cfg = db.dbConfig();
  console.log(`Connecting to ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} …`);
  try {
    await db.init();
    const store = db.get();
    console.log('✓ Connected and loaded the store.');
    console.log(`  users:      ${store.users.length}`);
    console.log(`  accounts:   ${store.accounts.length}`);
    console.log(`  associates: ${store.associates.length}`);
    console.log(`  entries:    ${store.entries.length}`);
    if (store.users.length === 0) {
      console.log('\n  (empty — run `npm run seed` to load data + default logins)');
    }
    await db.close();
    process.exit(0);
  } catch (err) {
    console.error(`\n✖ Connection failed: ${err.code || ''} ${err.message}`);
    console.error('  Fix DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME in .env and retry.\n');
    process.exit(1);
  }
})();
