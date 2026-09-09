// Reads the human-editable team roster from `emp details.txt` at the project root.
// This file is the source of truth for WHO the resources are; the app identifies
// each resource by their EMAIL (user, 2026-08-17). Seniority (Sr/Jr) drives the
// ₹/hr rate.
//
// Roster line format (one person per line, pipe-separated):
//   JW101 | Full Name | Designation | email@domain | Reporting Manager: X
// The parser is defensive: it finds the field that looks like an email, the JW id,
// the name and the designation regardless of small format wobbles. Seniority is
// inferred from the designation. `#` and blank lines are ignored.
const fs = require('fs');
const path = require('path');

const ROSTER_FILE = path.join(__dirname, '..', 'emp details.txt');
const CATEGORIES_FILE = path.join(__dirname, '..', 'emp categories.txt');
const PLACEHOLDER_DOMAIN = 'justwords.co';

// The three employee categories (user, 2026-08-21) — from
// "Employee categories for BNGM_18.8.26.xlsx". Each drives a ₹/hr rate tier.
const CATEGORIES = ['Senior', 'Middle', 'Junior'];

// Normalise any incoming category-ish string to one of the three tiers.
function normCategory(c) {
  const s = String(c || '').trim().toLowerCase();
  if (s.startsWith('sen') || s.startsWith('sr')) return 'Senior';
  if (s.startsWith('jun') || s.startsWith('jr')) return 'Junior';
  if (s.startsWith('mid')) return 'Middle';
  return 'Middle';
}

// Category ⇒ legacy binary seniority (kept so old code paths keep working):
// only "Senior" is a senior resource; Middle & Junior fall under the junior rate
// bucket in any pre-3-tier fallback path.
function typeFromCategory(cat) {
  return normCategory(cat) === 'Senior' ? 'Sr. Resource' : 'Jr. Resource';
}

// Seniority from a job title. Junior markers win over senior ones (e.g. a
// "Junior SEO Executive" is junior even though "Executive" is neutral).
function seniorityFromDesignation(desig) {
  const d = String(desig || '');
  if (/\b(jr\.?|junior|intern|trainee)\b/i.test(d)) return 'Jr. Resource';
  if (/(\bsr\.?\b|senior|lead|head|manager|director|ceo|founder|principal|architect|strategist|specialist|general manager|\bgm\b|\bagm\b|assistant general manager|\bvp\b|chief)/i.test(d))
    return 'Sr. Resource';
  return 'Jr. Resource';
}

// 3-tier category inferred from a job title, used only as a fallback when the
// authoritative categories file has no entry for a resource.
function categoryFromDesignation(desig) {
  const d = String(desig || '');
  if (/\b(jr\.?|junior|intern|trainee)\b/i.test(d)) return 'Junior';
  if (/(\bsr\.?\b|senior|lead|head|director|ceo|founder|principal|chief|general manager|\bgm\b|\bagm\b|\bvp\b)/i.test(d))
    return 'Senior';
  return 'Middle';
}

// Read "emp categories.txt" → Map of lowercase email → 'Senior'|'Middle'|'Junior'.
// This file is the authoritative source of each resource's category tier.
function parseCategories() {
  const map = new Map();
  let raw;
  try {
    raw = fs.readFileSync(CATEGORIES_FILE, 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const parts = s.split('|').map((p) => p.trim());
    let email = '';
    for (const p of parts) {
      if (looksLikeEmail(p)) { email = p.toLowerCase(); break; }
    }
    if (!email) continue;
    const cat = normCategory(parts[parts.length - 1]);
    map.set(email, cat);
  }
  return map;
}

// The category for a resource: the authoritative file wins; otherwise infer from
// the job title.
function categoryFor(email, designation, catMap) {
  const m = catMap || parseCategories();
  const e = String(email || '').toLowerCase();
  return m.get(e) || categoryFromDesignation(designation);
}

// Legacy helper kept for callers: "Sr"/"Senior" → senior, else junior.
function normType(t) {
  return /^\s*(sr|senior)/i.test(String(t || '')) ? 'Sr. Resource' : 'Jr. Resource';
}

// Turn a plain person name into a placeholder email, e.g. "Saurav Jha" →
// "saurav.jha@justwords.co". Used when a roster line has no real email.
function nameToEmail(name) {
  const local = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9.]/g, '');
  return local ? `${local}@${PLACEHOLDER_DOMAIN}` : '';
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

// Best-effort human name from an email address, used only as a fallback when we
// have no real name for a resource: "prerna.daga@justwords.in" → "Prerna Daga".
function emailToName(email) {
  const local = String(email || '').split('@')[0] || '';
  const words = local
    .replace(/[._\-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ');
}

// Parse the roster file → [{ jwId, fullName, type, email, name }].
// `name` mirrors `email` so existing callers (seed / sync) keep working — the app
// identifies a resource by this email string. Returns [] if the file is missing.
function parseRoster() {
  let raw;
  try {
    raw = fs.readFileSync(ROSTER_FILE, 'utf8');
  } catch {
    return [];
  }
  const people = [];
  const catMap = parseCategories();
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const parts = s.split('|').map((p) => p.trim());

    // JW id (e.g. "JW101") — first field if it matches.
    const jwId = /^JW\d+/i.test(parts[0]) ? parts[0].toUpperCase() : '';

    // Full name = the field right after the JW id (or the first field if none).
    const fullName = jwId ? (parts[1] || '') : (parts[0] || '');

    // Designation = the field after the name.
    const nameIdx = parts.indexOf(fullName);
    const designation = nameIdx >= 0 ? (parts[nameIdx + 1] || '') : '';

    // Email = the field that contains one; strip a leading "Email:" label. Skip
    // "N/A". Fall back to a placeholder derived from the name.
    let email = '';
    for (const p of parts) {
      const cleaned = p.replace(/^email\s*:\s*/i, '').trim();
      if (looksLikeEmail(cleaned)) { email = cleaned; break; }
    }
    if (!email) email = nameToEmail(fullName);
    if (!email) continue; // nothing usable on this line
    email = email.toLowerCase();

    const category = categoryFor(email, designation, catMap);
    people.push({
      jwId, fullName, email, name: email,
      category,
      type: typeFromCategory(category),
    });
  }
  return people;
}


// One-time migration: any existing associate still identified by a plain name
// (no "@") is converted in place to a placeholder email. Returns count changed.
function emailizeAssociates(store) {
  if (!Array.isArray(store.associates)) return 0;
  let changed = 0;
  for (const a of store.associates) {
    const ident = String(a.name || '').trim();
    if (ident && !ident.includes('@')) {
      a.name = nameToEmail(ident);
      changed++;
    }
  }
  return changed;
}

// Replace the datastore's associates with a fresh list built straight from the
// roster file (one resource per line, real email, inferred seniority). Used once
// via a migration flag to repair a datastore seeded before the parser understood
// the current `emp details.txt` format. Returns the number of associates written.
function rebuildAssociatesFromRoster(store) {
  const people = parseRoster();
  if (!people.length) return 0;
  const seen = new Set();
  const list = [];
  let id = 1;
  for (const p of people) {
    const key = p.email.toLowerCase();
    if (seen.has(key)) continue; // de-dupe by email, keep first
    seen.add(key);
    list.push({ id: id++, name: p.email, fullName: p.fullName || emailToName(p.email), type: p.type, category: p.category });
  }
  store.associates = list;
  return list.length;
}

// Set the `category` (Senior/Middle/Junior) on associates from the authoritative
// categories file, falling back to one inferred from the existing `type`.
// Returns count changed. Additive: never removes anyone or touches emails.
//   opts.onlyMissing = true → only fill associates that have no category yet, so a
//   Super's in-app "Manage team" edit is never reverted on later restarts. The
//   full (file-wins) pass is meant to run once, guarded by a meta flag.
function applyCategoriesToStore(store, opts = {}) {
  if (!Array.isArray(store.associates)) return 0;
  const onlyMissing = !!opts.onlyMissing;
  const catMap = parseCategories();
  let changed = 0;
  for (const a of store.associates) {
    const hasCat = a.category != null && String(a.category).trim() !== '';
    if (onlyMissing && hasCat) continue;
    const email = String(a.name || '').toLowerCase();
    const fromFile = onlyMissing ? undefined : catMap.get(email);
    const next = fromFile || (hasCat ? normCategory(a.category)
      : (catMap.get(email) || (String(a.type || '').toLowerCase().startsWith('sr') ? 'Senior' : 'Middle')));
    if (a.category !== next) { a.category = next; changed++; }
    // keep the legacy `type` in step with the category
    const t = typeFromCategory(next);
    if (a.type !== t) { a.type = t; }
  }
  return changed;
}

// Backfill a human-readable `fullName` on associates that don't have one yet.
// Matches each associate to the roster file by email (case-insensitive) to get
// the real name; falls back to a name derived from the email local-part. This
// repairs datastores seeded before associates carried a name, so the resource
// picker can be searched and displayed by name — not just email. Returns count.
function applyNamesToStore(store) {
  if (!Array.isArray(store.associates)) return 0;
  const byEmail = new Map();
  for (const p of parseRoster()) byEmail.set(p.email.toLowerCase(), p.fullName);
  let changed = 0;
  for (const a of store.associates) {
    if (a.fullName && String(a.fullName).trim()) continue;
    const email = String(a.name || '').toLowerCase();
    const nm = byEmail.get(email) || emailToName(email);
    if (nm) { a.fullName = nm; changed++; }
  }
  return changed;
}

// Non-destructively merge the roster file into the datastore's associates:
// adds people who aren't there yet (matched by email, case-insensitive).
// Never deletes and never overrides an existing person's seniority, so live
// in-app "Manage team" edits are preserved across restarts. Returns count added.
function syncRosterIntoStore(store) {
  const people = parseRoster();
  if (!people.length) return 0;
  if (!Array.isArray(store.associates)) store.associates = [];
  const have = new Set(store.associates.map((a) => String(a.name || '').trim().toLowerCase()));
  let added = 0;
  for (const p of people) {
    const key = p.email.toLowerCase();
    if (have.has(key)) continue;
    const id = store.associates.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
    store.associates.push({ id, name: p.email, fullName: p.fullName || emailToName(p.email), type: p.type, category: p.category });
    have.add(key);
    added++;
  }
  return added;
}

module.exports = {
  parseRoster,
  syncRosterIntoStore,
  rebuildAssociatesFromRoster,
  emailizeAssociates,
  applyNamesToStore,
  emailToName,
  applyCategoriesToStore,
  parseCategories,
  categoryFor,
  categoryFromDesignation,
  normCategory,
  typeFromCategory,
  nameToEmail,
  seniorityFromDesignation,
  normType,
  CATEGORIES,
  ROSTER_FILE,
  CATEGORIES_FILE,
};
