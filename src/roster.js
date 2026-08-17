// Reads the human-editable team roster from `emp details.txt` at the project root.
// This file is the source of truth for WHO the resources are; the app identifies
// each resource by their EMAIL (user, 2026-08-17). Seniority (Sr/Jr) drives the
// ₹/hr rate.
//
// Format, one person per line:   email@domain | Sr     or     email@domain | Jr
// "Sr"/"Senior" → senior; anything else → junior. `#` and blank lines are ignored.
// The email is stored in the associate's `name` field (the resource identifier).
const fs = require('fs');
const path = require('path');

const ROSTER_FILE = path.join(__dirname, '..', 'emp details.txt');
const PLACEHOLDER_DOMAIN = 'justwords.co';

function normType(t) {
  return /^\s*(sr|senior)/i.test(String(t || '')) ? 'Sr. Resource' : 'Jr. Resource';
}

// Turn a plain person name into a placeholder email, e.g. "Saurav Jha" →
// "saurav.jha@justwords.co". Used to migrate legacy name-based rosters to emails.
function nameToEmail(name) {
  const local = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9.]/g, '');
  return local ? `${local}@${PLACEHOLDER_DOMAIN}` : '';
}

// Parse the roster file → [{ name, type }] where `name` holds the email.
// Returns [] if the file is missing/empty.
function parseRoster() {
  let raw;
  try {
    raw = fs.readFileSync(ROSTER_FILE, 'utf8');
  } catch {
    return [];
  }
  const people = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    // Split on | , or tab; first field is the email, second (if any) is Sr/Jr.
    const parts = s.split(/\s*[|,\t]\s*/);
    let ident = (parts[0] || '').trim();
    if (!ident) continue;
    // Legacy safety: if a line still holds a plain name, coerce it to a placeholder
    // email so the whole system stays email-based.
    if (!ident.includes('@')) ident = nameToEmail(ident);
    people.push({ name: ident, type: normType(parts[1]) });
  }
  return people;
}

// One-time migration: any existing associate still identified by a plain name
// (no "@") is converted in place to a placeholder email, preserving its id and
// seniority so entries that reference it keep working. Returns count changed.
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
    const key = p.name.toLowerCase();
    if (have.has(key)) continue;
    const id = store.associates.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
    store.associates.push({ id, name: p.name, type: p.type });
    have.add(key);
    added++;
  }
  return added;
}

module.exports = { parseRoster, syncRosterIntoStore, emailizeAssociates, nameToEmail, ROSTER_FILE };
