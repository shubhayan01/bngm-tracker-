// Seeds the datastore from seed-data.json (extracted from the JW BNGM workbook).
// Creates default users with per-role passwords. Idempotent unless --force.
try { require('dotenv').config(); } catch { /* .env optional */ }
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { ROLES } = require('./auth');
const roster = require('./roster');
const clients = require('./clients');

const SEED_FILE = path.join(__dirname, '..', 'seed-data.json');

// Default passwords for first run. CHANGE THESE (Super can, in Settings).
const DEFAULT_PASSWORDS = {
  super: 'super123',
  admin: 'admin123',
  bizdev: 'bizdev123',
  seo: 'seo123',
  content: 'content123',
  social: 'social123',
  webdev: 'webdev123',
  perfmkt: 'perfmkt123',
};

async function run() {
  const force = process.argv.includes('--force');
  await db.init();
  const store = db.get();

  if (store.users.length > 0 && !force) {
    console.log('Datastore already seeded. Use `npm run reset` to wipe and reseed.');
    await db.close();
    return;
  }
  if (force) await db.reset();

  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const fresh = db.get();

  // Users
  fresh.users = Object.keys(ROLES).map((role, i) => ({
    id: i + 1,
    role,
    passwordHash: bcrypt.hashSync(DEFAULT_PASSWORDS[role] || role + '123', 10),
  }));

  // Settings: assumptions + monthly tool pool + master lists
  const toolPool = {};
  for (const m of seed.months) toolPool[m] = 0;

  fresh.settings = {
    assumptions: {
      srRate: seed.assumptions.srRate,
      midRate: seed.assumptions.midRate != null
        ? seed.assumptions.midRate
        : Math.round((seed.assumptions.srRate + seed.assumptions.jrRate) / 2),
      jrRate: seed.assumptions.jrRate,
      srCapacity: seed.assumptions.srCapacity,
      jrCapacity: seed.assumptions.jrCapacity,
      resourceMonthlyHours: seed.assumptions.resourceMonthlyHours || 180,
      contingency: seed.assumptions.contingency,
      gmMin: seed.assumptions.gmMin,
      gmHealthy: seed.assumptions.gmHealthy,
      fy: seed.assumptions.fy,
    },
    months: seed.months,
    wings: seed.wings,
    jobTypes: seed.jobTypes,
    toolPool,
    tools: (seed.tools || []).map((t, i) => ({
      id: i + 1,
      name: t.name,
      description: t.description || '',
      cost: t.cost || 0,
      currency: t.currency || 'USD',
      department: t.department || t.category || 'General',
      why: t.why || '',
      startDate: t.startDate || '',
      stopDate: t.stopDate || '',
      active: t.active !== undefined ? t.active : true,
    })),
  };

  // Accounts (default budget GM target = healthy threshold)
  fresh.accounts = seed.accounts.map((a, i) => ({
    id: i + 1,
    name: a.name,
    wing: a.wing || '',
    budgetGM: seed.assumptions.gmHealthy,
    active: true,
  }));

  // Associates / resources — prefer the editable `emp details.txt` roster;
  // fall back to the workbook-derived list if that file is empty/missing.
  const rosterPeople = roster.parseRoster();
  const associateSrc = rosterPeople.length ? rosterPeople : seed.associates;
  fresh.associates = associateSrc.map((a, i) => {
    const category = roster.normCategory(a.category != null ? a.category : a.type);
    return { id: i + 1, name: a.name, category, type: roster.typeFromCategory(category) };
  });
  // Authoritative pass: stamp each resource's category from "emp categories.txt".
  roster.applyCategoriesToStore(fresh);

  // Merge the client list (Book1 → clients.txt) on top of the workbook accounts.
  const clientsAdded = clients.syncClientsIntoStore(fresh);

  fresh.entries = [];

  await db.save();
  console.log('Seeded JW BNGM datastore:');
  console.log(`  ${fresh.accounts.length} accounts (${clientsAdded} merged from clients.txt), ${fresh.associates.length} associates`);
  console.log(`  ${fresh.settings.months.length} months, ${fresh.settings.wings.length} wings`);
  console.log('\nDefault logins (role / password) — change in Settings:');
  for (const role of Object.keys(ROLES)) {
    console.log(`  ${ROLES[role].label.padEnd(22)} ${role} / ${DEFAULT_PASSWORDS[role]}`);
  }
  await db.close();
}

run().catch((err) => {
  console.error('\n✖ Seed failed:', err.code || '', err.message);
  console.error('  Check your database settings (.env: DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME).\n');
  process.exit(1);
});
module.exports = { DEFAULT_PASSWORDS };
