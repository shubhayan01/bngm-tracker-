// Reads the human-editable client list from `clients.txt` at the project root
// (sourced from Book1.xlsx, user 2026-08-21) and merges it into the datastore's
// accounts non-destructively — adds any client not already present, matched by a
// normalised name, and never deletes or renames an existing account.
const fs = require('fs');
const path = require('path');

const CLIENTS_FILE = path.join(__dirname, '..', 'clients.txt');

// Loose name key so "COLOPLAST  INDIA PVT LTD." and "Coloplast India Pvt Ltd"
// collapse to the same client (case-, space- and punctuation-insensitive).
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Parse clients.txt → [name]. Returns [] if the file is missing.
function parseClients() {
  let raw;
  try {
    raw = fs.readFileSync(CLIENTS_FILE, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    out.push(s);
  }
  return out;
}

// Merge the client list into store.accounts. New clients get an empty wing
// (unassigned — Super can file them under a department later) and are active.
// Returns the number of accounts added.
function syncClientsIntoStore(store) {
  const names = parseClients();
  if (!names.length) return 0;
  if (!Array.isArray(store.accounts)) store.accounts = [];
  const have = new Set(store.accounts.map((a) => nameKey(a.name)));
  const gmHealthy = (store.settings && store.settings.assumptions && store.settings.assumptions.gmHealthy) || 0.4;
  let added = 0;
  for (const name of names) {
    const key = nameKey(name);
    if (!key || have.has(key)) continue;
    const id = store.accounts.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
    store.accounts.push({ id, name, wing: '', budgetGM: gmHealthy, active: true });
    have.add(key);
    added++;
  }
  return added;
}

module.exports = { parseClients, syncClientsIntoStore, nameKey, CLIENTS_FILE };
