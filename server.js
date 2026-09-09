try { require('dotenv').config(); } catch { /* .env is optional; real env vars still work */ }
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./src/db');
const { ROLES, signToken, verifyToken, roleCanSeeWing, visibleWings } = require('./src/auth');
const compute = require('./src/compute');
const fx = require('./src/fx');
const roster = require('./src/roster');
const clients = require('./src/clients');
const groq = require('./src/groq');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload || !ROLES[payload.role]) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.role = payload.role;
  req.roleDef = ROLES[payload.role];
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.roleDef[perm]) return res.status(403).json({ error: 'Not allowed for your role' });
    next();
  };
}

// Read-only roles (e.g. Admin) may view reports but never write.
function requireWrite(req, res, next) {
  if (req.roleDef.readOnly) return res.status(403).json({ error: 'Your access is read-only (reports only)' });
  next();
}

function visibleAccounts(role) {
  const store = db.get();
  return store.accounts.filter((a) => roleCanSeeWing(role, a.wing));
}

function canEditAccount(role, account) {
  return roleCanSeeWing(role, account.wing);
}

function settings() {
  return db.get().settings;
}

function entryKey(accountId, month) {
  return `${accountId}::${month}`;
}

function findEntry(accountId, month) {
  return db.get().entries.find((e) => e.accountId === accountId && e.month === month);
}

// ---------- dynamic months (user, 2026-08-21) ----------
// The month list is no longer a fixed FY. Entries may target any Month-Year the
// user picks (key format "Mon-YY", e.g. "Aug-26"); a new key is added to the
// catalogue on the fly so reports, the tool pool and the plan/actual picker follow.
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthOrder(key) {
  const m = /^([A-Za-z]{3})-(\d{2})$/.exec(String(key || ''));
  if (!m) return Infinity;
  const mon = m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase();
  const i = MONTHS3.indexOf(mon);
  if (i < 0) return Infinity;
  return (2000 + Number(m[2])) * 12 + i;
}
function validMonthKey(key) {
  return monthOrder(key) !== Infinity;
}
// Register a month key in the catalogue if it isn't there yet, keeping the list
// in chronological order and giving it a zero tool-pool slot.
function ensureMonth(key) {
  const s = settings();
  if (!Array.isArray(s.months)) s.months = [];
  if (!s.months.includes(key)) {
    s.months.push(key);
    s.months.sort((a, b) => monthOrder(a) - monthOrder(b));
  }
  if (!s.toolPool) s.toolPool = {};
  if (s.toolPool[key] == null) s.toolPool[key] = 0;
}

// month revenue totals across ALL accounts (needed for tool apportioning)
function monthTotals(mode) {
  return compute.monthRevenueTotals(db.get().entries, mode);
}

// Per-resource monthly hour capacity (default 180). A resource can't be booked
// beyond this across ALL clients in a month.
function resourceCapacity() {
  return compute.num(settings().assumptions.resourceMonthlyHours) || 180;
}

// Hours already booked per resource for a month, in a given mode, summed across
// ALL clients (global — capacity is not wing-scoped). Optionally exclude one
// account so the entry being edited doesn't count against itself.
function resourceMonthUsage(month, mode, excludeAccountId) {
  const key = mode === 'planned' ? 'resourcesPlan' : 'resourcesActual';
  const usage = {};
  for (const e of db.get().entries) {
    if (e.month !== month) continue;
    if (excludeAccountId != null && e.accountId === excludeAccountId) continue;
    for (const r of (e[key] || [])) {
      const id = Number(r.id);
      if (id) usage[id] = (usage[id] || 0) + compute.num(r.hours);
    }
  }
  return usage;
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { role, password } = req.body || {};
  const store = db.get();
  const user = store.users.find((u) => u.role === role);
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Wrong role or password' });
  }
  res.json({ token: signToken(user), role: user.role, roleInfo: publicRole(role) });
});

function publicRole(role) {
  const r = ROLES[role];
  return {
    role,
    label: r.label,
    // Report the concrete wings this role can see (wildcard roles are resolved
    // to the actual catalogue minus any `except`, so the UI never shows '*').
    wings: visibleWings(role, settings().wings),
    readOnly: !!r.readOnly,
    canCreateAccounts: r.canCreateAccounts,
    canManageUsers: r.canManageUsers,
    canEditSettings: r.canEditSettings,
    canManageTools: r.canManageTools,
    canManageClients: !!r.canManageClients,
  };
}

// ---------- bootstrap (everything the UI needs, role-filtered) ----------
app.get('/api/bootstrap', auth, async (req, res) => {
  const s = settings();
  const rate = await fx.getRate();
  res.json({
    roleInfo: publicRole(req.role),
    roles: Object.fromEntries(Object.keys(ROLES).map((k) => [k, ROLES[k].label])),
    accounts: visibleAccounts(req.role),
    associates: db.get().associates,
    assumptions: s.assumptions,
    months: s.months,
    // Departments only ever see their own wing names; Super sees all; Admin sees
    // all except Content Creation.
    wings: visibleWings(req.role, s.wings),
    jobTypes: s.jobTypes,
    tools: visibleTools(req.role),
    toolBudgets: s.toolBudgets || {},
    helpEnabled: groq.isEnabled(s),
    fx: { rate: rate.rate, live: rate.live, at: rate.at },
    toolPool: req.roleDef.canEditSettings ? s.toolPool : undefined,
  });
});

// ---------- live USD→INR rate ----------
app.get('/api/fx', auth, async (req, res) => {
  const rate = await fx.getRate(req.query.refresh === '1');
  res.json({ rate: rate.rate, live: rate.live, at: rate.at });
});

// ---------- help bot (Groq) ----------
// Any signed-in user can ask. We pass a compact, role-filtered snapshot so light
// reporting questions ("what's my YTD GM?") can be answered from real numbers.
app.post('/api/help', auth, async (req, res) => {
  const s = settings();
  if (!groq.isEnabled(s)) {
    return res.status(400).json({ error: 'Help bot is not set up yet. Super Admin can add a Groq API key under Assumptions → Help bot.' });
  }
  const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  if (!messages.length && req.body && req.body.question) {
    messages.push({ role: 'user', content: String(req.body.question) });
  }
  if (!messages.length) return res.status(400).json({ error: 'Ask a question first.' });

  // Build a small snapshot from what this role can see.
  let snapshot;
  try {
    const mode = 'auto';
    const totals = monthTotals(mode);
    const visIds = new Set(visibleAccounts(req.role).map((a) => a.id));
    const rows = db.get().entries.filter((e) => visIds.has(e.accountId)).map((e) =>
      compute.computeEntry(e, {
        assumptions: s.assumptions,
        toolPoolForMonth: (s.toolPool && s.toolPool[e.month]) || 0,
        totalMonthRevenue: totals[e.month] || 0,
        mode,
      }));
    const sum = (f) => rows.reduce((a, c) => a + (c[f] || 0), 0);
    const revenue = sum('revenue');
    const totalCost = sum('totalCost');
    const grossProfit = revenue - totalCost;
    snapshot = {
      role: publicRole(req.role).label,
      ytd: { revenue, totalCost, grossProfit, gm: revenue > 0 ? grossProfit / revenue : 0 },
      accountsVisible: visIds.size,
      months: s.months,
      assumptions: {
        srRate: s.assumptions.srRate, midRate: s.assumptions.midRate, jrRate: s.assumptions.jrRate,
        resourceMonthlyHours: s.assumptions.resourceMonthlyHours,
        gmMin: s.assumptions.gmMin, gmHealthy: s.assumptions.gmHealthy,
      },
    };
  } catch { snapshot = undefined; }

  try {
    const reply = await groq.ask(s, messages, snapshot);
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Help bot request failed' });
  }
});

// ---------- accounts (clients) ----------
// A "client" is a name; it can belong to several departments (one account row per
// department). Any role that can create accounts may ADD a client, but a department
// is locked to its own department — only Super can move a client between departments
// or delete/rename it (user, 2026-08-21). The client lands in the shared database
// and in that department's data at once.
app.post('/api/accounts', auth, requirePerm('canCreateAccounts'), (req, res) => {
  const { name, wing, budgetGM } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Client name required' });
  const nm = String(name).trim();
  let finalWing = String(wing || '');
  // Departments can only create within a wing they own — they cannot choose another
  // department for the client.
  if (req.roleDef.wings !== '*') {
    if (!Array.isArray(req.roleDef.wings) || req.roleDef.wings.length === 0) {
      return res.status(403).json({ error: 'Your role has no department assigned — ask Super Admin.' });
    }
    if (!roleCanSeeWing(req.role, finalWing)) finalWing = req.roleDef.wings[0];
  }
  const store = db.get();
  // Idempotent: same client + department already exists → just return it (no dupes).
  const existing = store.accounts.find(
    (a) => String(a.name).toLowerCase() === nm.toLowerCase() && (a.wing || '') === finalWing);
  if (existing) return res.json(existing);
  const acc = {
    id: db.nextId('accounts'),
    name: nm,
    wing: finalWing,
    budgetGM: budgetGM != null ? Number(budgetGM) : settings().assumptions.gmHealthy,
  };
  store.accounts.push(acc);
  db.save().then(() => res.json(acc));
});

// Super only: edit a client (rename, move to another department). Whatever Super
// changes overwrites the live data everywhere (all views read this one store).
app.put('/api/accounts/:id', auth, requirePerm('canManageClients'), (req, res) => {
  const id = Number(req.params.id);
  const store = db.get();
  const acc = store.accounts.find((a) => a.id === id);
  if (!acc) return res.status(404).json({ error: 'Client not found' });
  const { name, wing, budgetGM } = req.body || {};
  if (name != null) acc.name = String(name).trim();
  if (budgetGM != null) acc.budgetGM = Number(budgetGM);
  if (wing != null) acc.wing = String(wing); // Super may assign the client to any department
  db.save().then(() => res.json(acc));
});

// Super only: delete a client (a single department-account). Its entries are purged
// too so no orphaned data lingers.
app.delete('/api/accounts/:id', auth, requirePerm('canManageClients'), (req, res) => {
  const id = Number(req.params.id);
  const store = db.get();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.accounts.length === before) return res.status(404).json({ error: 'Client not found' });
  const entriesBefore = store.entries.length;
  store.entries = store.entries.filter((e) => e.accountId !== id);
  db.save().then(() => res.json({ ok: true, id, removedEntries: entriesBefore - store.entries.length }));
});

// ---------- tools catalog ----------
// View: Super sees all; other roles see only their own department's tools.
// Edit / delete: Super only.
function nextToolId() {
  const t = settings().tools || [];
  return t.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}
function cleanDate(v) {
  if (v == null || v === '') return '';
  const s = String(v).slice(0, 10); // YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
// Normalise a { department: cost } split map (used only by common tools) —
// trims/dedupes department names, coerces to non-negative numbers, drops zeros.
function cleanDeptCosts(v) {
  const out = {};
  if (v && typeof v === 'object') {
    for (const [dept, val] of Object.entries(v)) {
      const name = String(dept || '').trim();
      const cost = Math.max(0, compute.num(val));
      if (name && cost > 0) out[name] = cost;
    }
  }
  return out;
}
function cleanTool(b, base = {}) {
  const common = b.common != null ? !!b.common : base.common !== undefined ? !!base.common : false;
  // A common tool is shared by every department; its department label is fixed and
  // its cost is budgeted per department via `deptCosts` (user, 2026-08-21). The
  // total monthly `cost` for a common tool is the sum of its per-department split.
  let department = b.department != null ? String(b.department) : base.department || 'General';
  const deptCosts = common
    ? (b.deptCosts != null ? cleanDeptCosts(b.deptCosts) : cleanDeptCosts(base.deptCosts))
    : {};
  if (common) department = 'All departments';
  let cost;
  if (common) {
    const sum = Object.values(deptCosts).reduce((s, x) => s + x, 0);
    // Fall back to any explicit total only when no split was provided.
    cost = sum > 0 ? sum : (b.cost != null ? compute.num(b.cost) : base.cost || 0);
  } else {
    cost = b.cost != null ? compute.num(b.cost) : base.cost || 0;
  }
  return {
    ...base,
    name: b.name != null ? String(b.name).trim() : base.name || '',
    description: b.description != null ? String(b.description) : base.description || '',
    cost,
    currency: b.currency === 'INR' ? 'INR' : b.currency === 'USD' ? 'USD' : base.currency || 'USD',
    common,
    department,
    deptCosts,
    why: b.why != null ? String(b.why) : base.why || '',
    startDate: b.startDate != null ? cleanDate(b.startDate) : base.startDate || '',
    stopDate: b.stopDate != null ? cleanDate(b.stopDate) : base.stopDate || '',
    active: b.active != null ? !!b.active : base.active !== undefined ? base.active : true,
  };
}

// Tool visibility (user, 2026-08-21): Super sees everything; every other role sees
// only its own department's tools (never common tools, which are Super-only). Tools
// tagged "General" are shared org-wide and stay visible to all.
function visibleTools(role) {
  const s = settings();
  const all = s.tools || [];
  if (ROLES[role] && ROLES[role].canEditSettings) return all;
  const wings = visibleWings(role, s.wings);
  return all.filter((t) => !t.common && (t.department === 'General' || wings.includes(t.department)));
}

app.get('/api/tools', auth, (req, res) => {
  res.json(visibleTools(req.role));
});

app.post('/api/tools', auth, requirePerm('canManageTools'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Tool name required' });
  const s = settings();
  if (!Array.isArray(s.tools)) s.tools = [];
  const tool = { id: nextToolId(), ...cleanTool(b) };
  if (!tool.startDate) tool.startDate = new Date().toISOString().slice(0, 10);
  s.tools.push(tool);
  db.save().then(() => res.json(tool));
});

app.put('/api/tools/:id', auth, requirePerm('canManageTools'), (req, res) => {
  const id = Number(req.params.id);
  const s = settings();
  const tool = (s.tools || []).find((t) => t.id === id);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  Object.assign(tool, cleanTool(req.body || {}, tool));
  db.save().then(() => res.json(tool));
});

app.delete('/api/tools/:id', auth, requirePerm('canManageTools'), (req, res) => {
  const id = Number(req.params.id);
  const s = settings();
  const before = (s.tools || []).length;
  s.tools = (s.tools || []).filter((t) => t.id !== id);
  if (s.tools.length === before) return res.status(404).json({ error: 'Tool not found' });
  db.save().then(() => res.json({ ok: true, id }));
});

// ---------- associates / team (resources) ----------
// Everyone signed in sees them (needed to pick resources on an entry).
// Only settings-capable roles (Super) may add / adjust the category.
// Each resource carries a `category` (Senior / Middle / Junior) which drives the
// ₹/hr rate tier; `type` is kept in step for any legacy binary code path.
function categoryOf(a) {
  return roster.normCategory(a && (a.category != null ? a.category : a.type));
}

app.get('/api/associates', auth, (req, res) => {
  res.json(db.get().associates || []);
});

app.post('/api/associates', auth, requirePerm('canEditSettings'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name required' });
  const store = db.get();
  const category = roster.normCategory(b.category != null ? b.category : b.type);
  const email = String(b.name).trim();
  const fullName = (b.fullName && String(b.fullName).trim()) || roster.emailToName(email) || email;
  const a = { id: db.nextId('associates'), name: email, fullName, category, type: roster.typeFromCategory(category) };
  store.associates.push(a);
  db.save().then(() => res.json(a));
});

app.put('/api/associates/:id', auth, requirePerm('canEditSettings'), (req, res) => {
  const id = Number(req.params.id);
  const store = db.get();
  const a = (store.associates || []).find((x) => x.id === id);
  if (!a) return res.status(404).json({ error: 'Resource not found' });
  const b = req.body || {};
  if (b.name != null) a.name = String(b.name).trim();
  if (b.fullName != null) a.fullName = String(b.fullName).trim();
  if (!a.fullName) a.fullName = roster.emailToName(a.name) || a.name;
  if (b.category != null || b.type != null) {
    a.category = roster.normCategory(b.category != null ? b.category : b.type);
    a.type = roster.typeFromCategory(a.category);
  }
  db.save().then(() => res.json(a));
});

app.delete('/api/associates/:id', auth, requirePerm('canEditSettings'), (req, res) => {
  const id = Number(req.params.id);
  const store = db.get();
  const before = (store.associates || []).length;
  store.associates = (store.associates || []).filter((x) => x.id !== id);
  if (store.associates.length === before) return res.status(404).json({ error: 'Resource not found' });
  db.save().then(() => res.json({ ok: true, id }));
});

// ---------- single entry (for the bot / wizard) ----------
app.get('/api/entry', auth, (req, res) => {
  const accountId = Number(req.query.accountId);
  const month = String(req.query.month || '');
  const store = db.get();
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!canEditAccount(req.role, acc)) return res.status(403).json({ error: 'Not your account' });
  const mode = req.query.mode === 'planned' ? 'planned' : req.query.mode === 'actual' ? 'actual' : 'auto';
  const entry = findEntry(accountId, month) || emptyEntry(accountId, month);
  // Resource availability: capacity + hours already booked on OTHER clients this
  // month (so the UI can show what's free and stop over-allocation).
  const usageMode = mode === 'planned' ? 'planned' : 'actual';
  res.json({
    entry,
    computed: computeFor(entry, mode),
    capacity: resourceCapacity(),
    usageOther: resourceMonthUsage(month, usageMode, accountId),
  });
});

function emptyEntry(accountId, month) {
  return {
    accountId,
    month,
    revPlanned: 0,
    revActual: 0,
    srHrs: 0,
    midHrs: 0,
    jrHrs: 0,
    srHrsPlan: 0,
    midHrsPlan: 0,
    jrHrsPlan: 0,
    resourcesActual: [], // [{ id, hours }] per named employee
    resourcesPlan: [],
    // Outsourcing & notes are split Plan vs Actual (user, 2026-08-24). `outsourcing`
    // / `notes` are kept only as a legacy fallback for entries saved before the split.
    outsourcing: [],
    outsourcingPlan: [],
    outsourcingActual: [],
    wcPlanned: 0,
    wcDelivered: 0,
    notes: '',
    notesPlan: '',
    notesActual: '',
  };
}

function computeFor(entry, mode = 'auto') {
  const s = settings();
  const totals = monthTotals(mode);
  return compute.computeEntry(entry, {
    assumptions: s.assumptions,
    toolPoolForMonth: (s.toolPool && s.toolPool[entry.month]) || 0,
    totalMonthRevenue: totals[entry.month] || 0,
    mode,
  });
}

app.put('/api/entry', auth, requireWrite, (req, res) => {
  const b = req.body || {};
  const accountId = Number(b.accountId);
  const month = String(b.month || '');
  const store = db.get();
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!canEditAccount(req.role, acc)) return res.status(403).json({ error: 'Not your account' });
  if (!validMonthKey(month)) return res.status(400).json({ error: 'Bad month (expected e.g. "Aug-26")' });
  ensureMonth(month); // extend the catalogue on the fly for any new Month-Year

  const assocById = Object.fromEntries((store.associates || []).map((a) => [a.id, a]));
  const cleanResources = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((r) => ({ id: Number(r.id), hours: compute.num(r.hours) }))
      .filter((r) => r.id && r.hours > 0);
  // Split booked hours across the three categories (Senior / Middle / Junior) so
  // each is costed at its own ₹/hr rate tier.
  const sumByCategory = (arr) => {
    let sr = 0, mid = 0, jr = 0;
    for (const r of arr) {
      const cat = categoryOf(assocById[r.id]);
      if (cat === 'Senior') sr += r.hours;
      else if (cat === 'Middle') mid += r.hours;
      else jr += r.hours;
    }
    return { sr, mid, jr };
  };

  // Clean + capacity-check the per-person breakdown BEFORE mutating anything, so a
  // rejected save leaves the datastore untouched. A resource can't exceed its
  // monthly hour cap across all clients (this account's own hours are excluded).
  const cap = resourceCapacity();
  const checkCapacity = (arr, m) => {
    const other = resourceMonthUsage(month, m, accountId);
    for (const r of arr) {
      if ((other[r.id] || 0) + r.hours > cap) {
        const nm = (assocById[r.id] && (assocById[r.id].fullName || assocById[r.id].name)) || ('#' + r.id);
        const free = Math.max(0, cap - (other[r.id] || 0));
        return `${nm} is already booked ${other[r.id] || 0} hr in ${month} on other clients — only ${free} of ${cap} hrs free, but you entered ${r.hours}.`;
      }
    }
    return null;
  };
  let cleanAct = null, cleanPlan = null;
  if (Array.isArray(b.resourcesActual) && b.resourcesActual.length) {
    cleanAct = cleanResources(b.resourcesActual);
    const err = checkCapacity(cleanAct, 'actual');
    if (err) return res.status(400).json({ error: err });
  }
  if (Array.isArray(b.resourcesPlan) && b.resourcesPlan.length) {
    cleanPlan = cleanResources(b.resourcesPlan);
    const err = checkCapacity(cleanPlan, 'planned');
    if (err) return res.status(400).json({ error: err });
  }

  let entry = findEntry(accountId, month);
  if (!entry) {
    entry = emptyEntry(accountId, month);
    entry.id = db.nextId('entries');
    store.entries.push(entry);
  }
  const numFields = ['revPlanned', 'revActual', 'srHrs', 'midHrs', 'jrHrs', 'srHrsPlan', 'midHrsPlan', 'jrHrsPlan', 'wcPlanned', 'wcDelivered'];
  for (const f of numFields) if (b[f] != null) entry[f] = compute.num(b[f]);

  // Only apply a breakdown when a non-empty one was sent, so legacy entries that
  // only carry aggregate srHrs/jrHrs are never clobbered by an empty array.
  if (cleanAct) {
    entry.resourcesActual = cleanAct;
    const t = sumByCategory(cleanAct);
    entry.srHrs = t.sr; entry.midHrs = t.mid; entry.jrHrs = t.jr;
  }
  if (cleanPlan) {
    entry.resourcesPlan = cleanPlan;
    const t = sumByCategory(cleanPlan);
    entry.srHrsPlan = t.sr; entry.midHrsPlan = t.mid; entry.jrHrsPlan = t.jr;
  }
  // Outsourcing & notes are split Plan vs Actual (user, 2026-08-24). Whichever keys
  // the client sends are applied; the legacy shared `outsourcing`/`notes` are kept in
  // step for back-compat so old readers / entries still cost correctly.
  const cleanOut = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((o) => o && (o.jobType || o.cost))
    .map((o) => ({ jobType: String(o.jobType || 'Others'), cost: compute.num(o.cost), vendor: String(o.vendor || '') }));
  for (const key of ['outsourcing', 'outsourcingPlan', 'outsourcingActual']) {
    if (Array.isArray(b[key])) entry[key] = cleanOut(b[key]);
  }
  for (const key of ['notes', 'notesPlan', 'notesActual']) {
    if (b[key] != null) entry[key] = String(b[key]);
  }
  entry.updatedBy = req.role;
  entry.updatedAt = new Date().toISOString();

  const mode = b.mode === 'planned' ? 'planned' : b.mode === 'actual' ? 'actual' : 'auto';
  const usageMode = mode === 'planned' ? 'planned' : 'actual';
  db.save().then(() => res.json({
    entry,
    computed: computeFor(entry, mode),
    capacity: resourceCapacity(),
    usageOther: resourceMonthUsage(month, usageMode, accountId),
  }));
});

// ---------- dashboards ----------
app.get('/api/dashboard', auth, (req, res) => {
  const s = settings();
  const mode = req.query.mode === 'planned' ? 'planned' : req.query.mode === 'actual' ? 'actual' : 'auto';
  const store = db.get();
  const visIds = new Set(visibleAccounts(req.role).map((a) => a.id));
  const accById = Object.fromEntries(store.accounts.map((a) => [a.id, a]));
  const totals = monthTotals(mode);

  // enrich every visible entry with its computation
  const rows = store.entries
    .filter((e) => visIds.has(e.accountId))
    .map((e) => {
      const c = compute.computeEntry(e, {
        assumptions: s.assumptions,
        toolPoolForMonth: (s.toolPool && s.toolPool[e.month]) || 0,
        totalMonthRevenue: totals[e.month] || 0,
        mode,
      });
      return { e, c, acc: accById[e.accountId] };
    });

  // 1) Monthly portfolio snapshot
  const monthly = s.months.map((m) => {
    const mr = rows.filter((r) => r.e.month === m);
    const agg = aggregate(mr, s.assumptions);
    return { month: m, ...agg };
  });
  const ytd = aggregate(rows, s.assumptions);

  // 2) Wing summary (YTD)
  const wingSet = visibleWings(req.role, s.wings);
  const wingSummary = wingSet.map((w) => {
    const wr = rows.filter((r) => r.acc && r.acc.wing === w);
    return { wing: w, ...aggregate(wr, s.assumptions) };
  });

  // 3) Account ranking (YTD) — sum per account
  const byAcc = {};
  for (const r of rows) {
    const id = r.e.accountId;
    if (!byAcc[id]) byAcc[id] = { acc: r.acc, rows: [] };
    byAcc[id].rows.push(r);
  }
  const ranking = Object.values(byAcc)
    .map(({ acc, rows: rr }) => {
      const a = aggregate(rr, s.assumptions);
      return {
        accountId: acc.id,
        name: acc.name,
        wing: acc.wing,
        budgetGM: acc.budgetGM,
        revenue: a.revenue,
        totalCost: a.totalCost,
        grossProfit: a.grossProfit,
        gm: a.gm,
        status: a.status,
        variance: a.gm - (acc.budgetGM || 0),
      };
    })
    .sort((x, y) => y.gm - x.gm);

  // 4) Plan vs Actual comparison — aggregate each visible entry under BOTH modes.
  const rowsFor = (mm) => {
    const tot = monthTotals(mm);
    return store.entries
      .filter((e) => visIds.has(e.accountId))
      .map((e) => ({
        e,
        acc: accById[e.accountId],
        c: compute.computeEntry(e, {
          assumptions: s.assumptions,
          toolPoolForMonth: (s.toolPool && s.toolPool[e.month]) || 0,
          totalMonthRevenue: tot[e.month] || 0,
          mode: mm,
        }),
      }));
  };
  const planRows = rowsFor('planned');
  const actualRows = rowsFor('actual');
  const comparison = s.months.map((m) => {
    const p = aggregate(planRows.filter((r) => r.e.month === m), s.assumptions);
    const a = aggregate(actualRows.filter((r) => r.e.month === m), s.assumptions);
    return {
      month: m,
      planRevenue: p.revenue, actualRevenue: a.revenue,
      planCost: p.totalCost, actualCost: a.totalCost,
      planGP: p.grossProfit, actualGP: a.grossProfit,
      planGM: p.gm, actualGM: a.gm,
      revVariance: a.revenue - p.revenue,
      gpVariance: a.grossProfit - p.grossProfit,
      gmVariance: a.gm - p.gm,
    };
  });
  // 4b) Plan vs Actual per customer (client name) — aggregate each client's plan and
  // actual across every department + month it appears in (user, 2026-08-24).
  const byNamePlan = {};
  const byNameAct = {};
  const nameOf = (r) => (r.acc && r.acc.name) || '—';
  for (const r of planRows) (byNamePlan[nameOf(r)] = byNamePlan[nameOf(r)] || []).push(r);
  for (const r of actualRows) (byNameAct[nameOf(r)] = byNameAct[nameOf(r)] || []).push(r);
  const cmpNames = [...new Set([...Object.keys(byNamePlan), ...Object.keys(byNameAct)])];
  const comparisonByClient = cmpNames.map((name) => {
    const p = aggregate(byNamePlan[name] || [], s.assumptions);
    const a = aggregate(byNameAct[name] || [], s.assumptions);
    const wings = [...new Set((byNamePlan[name] || []).concat(byNameAct[name] || [])
      .map((r) => r.acc && r.acc.wing).filter(Boolean))];
    return {
      name, wings,
      planRevenue: p.revenue, actualRevenue: a.revenue,
      planCost: p.totalCost, actualCost: a.totalCost,
      planGP: p.grossProfit, actualGP: a.grossProfit,
      planGM: p.gm, actualGM: a.gm,
      revVariance: a.revenue - p.revenue,
      gpVariance: a.grossProfit - p.grossProfit,
      gmVariance: a.gm - p.gm,
    };
  })
    .filter((r) => r.planRevenue || r.actualRevenue)
    .sort((x, y) => y.actualRevenue - x.actualRevenue);

  const cmpPlan = aggregate(planRows, s.assumptions);
  const cmpActual = aggregate(actualRows, s.assumptions);
  const comparisonYtd = {
    planRevenue: cmpPlan.revenue, actualRevenue: cmpActual.revenue,
    planCost: cmpPlan.totalCost, actualCost: cmpActual.totalCost,
    planGP: cmpPlan.grossProfit, actualGP: cmpActual.grossProfit,
    planGM: cmpPlan.gm, actualGM: cmpActual.gm,
    revVariance: cmpActual.revenue - cmpPlan.revenue,
    gpVariance: cmpActual.grossProfit - cmpPlan.grossProfit,
    gmVariance: cmpActual.gm - cmpPlan.gm,
  };

  // 5) Resources plan vs actual (user, 2026-08-26). Per client and per resource:
  // planned vs actual booked hours (and ₹ cost), summed across every department +
  // month. Powers the Resources report and its Asana links (people are keyed by email).
  const assocByIdD = Object.fromEntries((store.associates || []).map((a) => [a.id, a]));
  const catRates = compute.rates(s.assumptions);
  const rateOfCat = (cat) => cat === 'Senior' ? catRates.sr : cat === 'Junior' ? catRates.jr : catRates.mid;
  const resByClient = {};
  const resByPerson = {};
  const bumpPerson = (id, key, hrs) => {
    const a = assocByIdD[id];
    const p = resByPerson[id] || (resByPerson[id] = {
      id, name: a ? (a.fullName || a.name) : ('#' + id), email: a ? a.name : '', category: a ? categoryOf(a) : '', planHours: 0, actualHours: 0,
    });
    p[key] += hrs;
  };
  for (const e of store.entries) {
    if (!visIds.has(e.accountId)) continue;
    const acc = accById[e.accountId];
    const cname = (acc && acc.name) || '—';
    const bag = resByClient[cname] || (resByClient[cname] = {
      name: cname, planHours: 0, actualHours: 0, planCost: 0, actualCost: 0,
    });
    for (const x of (e.resourcesPlan || [])) {
      const a = assocByIdD[x.id]; const h = compute.num(x.hours);
      bag.planHours += h; bag.planCost += h * rateOfCat(a ? categoryOf(a) : 'Middle');
      bumpPerson(Number(x.id), 'planHours', h);
    }
    for (const x of (e.resourcesActual || [])) {
      const a = assocByIdD[x.id]; const h = compute.num(x.hours);
      bag.actualHours += h; bag.actualCost += h * rateOfCat(a ? categoryOf(a) : 'Middle');
      bumpPerson(Number(x.id), 'actualHours', h);
    }
  }
  const resourceByClient = Object.values(resByClient)
    .filter((r) => r.planHours || r.actualHours)
    .map((r) => ({ ...r, hoursVariance: r.actualHours - r.planHours, costVariance: r.actualCost - r.planCost }))
    .sort((a, b) => b.actualHours - a.actualHours);
  // % utilisation of each resource's time = actual booked hours ÷ their capacity for
  // the whole period (monthly hour cap × number of months) (user, 2026-09-01).
  const capPerMonth = compute.num(s.assumptions.resourceMonthlyHours) || 180;
  const capTotal = capPerMonth * (Array.isArray(s.months) ? s.months.length : 0);
  const resourceByPerson = Object.values(resByPerson)
    .filter((r) => r.planHours || r.actualHours)
    .map((r) => ({
      ...r,
      hoursVariance: r.actualHours - r.planHours,
      capacity: capTotal,
      utilisation: capTotal ? r.actualHours / capTotal : 0,
    }))
    .sort((a, b) => b.actualHours - a.actualHours);

  res.json({
    mode, months: s.months, ytd, monthly, wingSummary, ranking,
    comparison, comparisonByClient, comparisonYtd, resourceByClient, resourceByPerson,
  });
});

// ---------- drill-down detail (a full breakdown for one month or one client) ----------
// Powers the "🔍 details" buttons in Reports (user, 2026-08-24). Opens in a new tab
// (?view=detail&type=…&key=…) and shows every entry, both Plan and Actual, with the
// resource, outsourcing and notes behind each figure. Role-filtered like everything else.
app.get('/api/detail', auth, (req, res) => {
  const s = settings();
  const store = db.get();
  const type = req.query.type === 'client' ? 'client' : 'month';
  const key = String(req.query.key || '');
  const visIds = new Set(visibleAccounts(req.role).map((a) => a.id));
  const accById = Object.fromEntries(store.accounts.map((a) => [a.id, a]));
  const assocById = Object.fromEntries((store.associates || []).map((a) => [a.id, a]));

  const resolveResources = (arr) => (Array.isArray(arr) ? arr : []).map((r) => {
    const a = assocById[r.id];
    return { id: r.id, name: a ? (a.fullName || a.name) : ('#' + r.id), email: a ? a.name : '', category: a ? categoryOf(a) : '', hours: compute.num(r.hours) };
  });
  const detailFor = (e) => {
    const acc = accById[e.accountId];
    return {
      accountId: e.accountId,
      name: acc ? acc.name : '—',
      wing: acc ? acc.wing : '',
      month: e.month,
      plan: computeFor(e, 'planned'),
      actual: computeFor(e, 'actual'),
      resourcesPlan: resolveResources(e.resourcesPlan),
      resourcesActual: resolveResources(e.resourcesActual),
      outsourcingPlan: compute.outsourcingArr(e, 'planned'),
      outsourcingActual: compute.outsourcingArr(e, 'actual'),
      notesPlan: e.notesPlan || e.notes || '',
      notesActual: e.notesActual || e.notes || '',
    };
  };
  const sumMode = (items, mode) => {
    const f = (k) => items.reduce((x, it) => x + (Number(it[mode][k]) || 0), 0);
    const revenue = f('revenue'), totalCost = f('totalCost');
    return {
      revenue, manpower: f('manpower'), outsourcing: f('outsourcing'), toolShare: f('toolShare'),
      totalCost, grossProfit: revenue - totalCost, gm: revenue > 0 ? (revenue - totalCost) / revenue : 0,
    };
  };

  let items;
  if (type === 'month') {
    items = store.entries.filter((e) => visIds.has(e.accountId) && e.month === key).map(detailFor);
    items.sort((a, b) => String(a.wing).localeCompare(String(b.wing)) || String(a.name).localeCompare(String(b.name)));
  } else {
    items = store.entries
      .filter((e) => visIds.has(e.accountId) && accById[e.accountId] && String(accById[e.accountId].name).toLowerCase() === key.toLowerCase())
      .map(detailFor);
    items.sort((a, b) => monthOrder(a.month) - monthOrder(b.month) || String(a.wing).localeCompare(String(b.wing)));
  }
  res.json({ type, key, planTotals: sumMode(items, 'plan'), actualTotals: sumMode(items, 'actual'), items });
});

function aggregate(rows, a) {
  const sum = (f) => rows.reduce((s, r) => s + r.c[f], 0);
  const revenue = sum('revenue');
  const manpower = sum('manpower');
  const outsourcing = sum('outsourcing');
  const toolShare = sum('toolShare');
  const totalCost = sum('totalCost');
  const grossProfit = revenue - totalCost;
  const gm = revenue > 0 ? grossProfit / revenue : 0;
  const activeAccts = new Set(rows.filter((r) => r.c.revenue > 0).map((r) => r.e.accountId));
  let healthy = 0, review = 0, atrisk = 0;
  for (const r of rows) {
    if (r.c.status === 'healthy') healthy++;
    else if (r.c.status === 'review') review++;
    else if (r.c.status === 'atrisk') atrisk++;
  }
  return {
    revenue, manpower, outsourcing, toolShare, totalCost, grossProfit, gm,
    status: compute.statusOf(gm, revenue > 0, a),
    activeAccounts: activeAccts.size,
    healthy, review, atrisk,
  };
}

// ---------- settings (super only) ----------
app.get('/api/settings', auth, requirePerm('canEditSettings'), (req, res) => {
  res.json(settings());
});

app.put('/api/settings/assumptions', auth, requirePerm('canEditSettings'), (req, res) => {
  const s = settings();
  const b = req.body || {};
  for (const k of ['srRate', 'midRate', 'jrRate', 'srCapacity', 'jrCapacity', 'resourceMonthlyHours', 'gmMin', 'gmHealthy']) {
    if (b[k] != null) s.assumptions[k] = compute.num(b[k]);
  }
  if (b.fy != null) s.assumptions.fy = String(b.fy);
  db.save().then(() => res.json(s.assumptions));
});

// Super-only: monthly tool budget allocated to each department. The whole map is
// replaced in one call ({ department: monthlyBudgetINR }).
app.put('/api/settings/toolbudgets', auth, requirePerm('canEditSettings'), (req, res) => {
  const s = settings();
  const b = (req.body && req.body.budgets) || req.body || {};
  const out = {};
  for (const [dept, val] of Object.entries(b)) {
    const name = String(dept || '').trim();
    if (!name) continue;
    out[name] = Math.max(0, compute.num(val));
  }
  s.toolBudgets = out;
  db.save().then(() => res.json(s.toolBudgets));
});

app.put('/api/settings/toolpool', auth, requirePerm('canEditSettings'), (req, res) => {
  const s = settings();
  const b = req.body || {};
  for (const m of s.months) if (b[m] != null) s.toolPool[m] = compute.num(b[m]);
  db.save().then(() => res.json(s.toolPool));
});

// Super-only: manage the outsourcing options list (job types). The whole list is
// replaced in one call — the UI adds/removes rows and saves the result.
app.put('/api/settings/jobtypes', auth, requirePerm('canEditSettings'), (req, res) => {
  const s = settings();
  const b = req.body || {};
  if (!Array.isArray(b.jobTypes)) return res.status(400).json({ error: 'jobTypes array required' });
  const seen = new Set();
  const list = [];
  for (const j of b.jobTypes) {
    const name = String(j || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // de-dupe, keep first
    seen.add(key);
    list.push(name);
  }
  if (!list.length) return res.status(400).json({ error: 'Keep at least one outsourcing option' });
  s.jobTypes = list;
  db.save().then(() => res.json(s.jobTypes));
});

// Super-only: configure the Groq help bot. Returns only whether a key is set
// (never echoes the key back to the client).
app.get('/api/settings/help', auth, requirePerm('canEditSettings'), (req, res) => {
  const s = settings();
  res.json({
    hasKey: !!(s.groqApiKey || process.env.GROQ_API_KEY),
    envKey: !!process.env.GROQ_API_KEY,
    model: s.groqModel || groq.DEFAULT_MODEL,
  });
});
app.put('/api/settings/help', auth, requirePerm('canEditSettings'), (req, res) => {
  const s = settings();
  const b = req.body || {};
  // Empty string clears the stored key; a non-empty string sets it. `undefined`
  // (field omitted) leaves it untouched.
  if (b.apiKey !== undefined) {
    const v = String(b.apiKey || '').trim();
    if (v) s.groqApiKey = v; else delete s.groqApiKey;
  }
  if (b.model !== undefined) {
    const v = String(b.model || '').trim();
    if (v) s.groqModel = v; else delete s.groqModel;
  }
  db.save().then(() => res.json({
    hasKey: !!(s.groqApiKey || process.env.GROQ_API_KEY),
    envKey: !!process.env.GROQ_API_KEY,
    model: s.groqModel || groq.DEFAULT_MODEL,
  }));
});

app.put('/api/settings/password', auth, requirePerm('canManageUsers'), (req, res) => {
  const { role, newPassword } = req.body || {};
  if (!ROLES[role]) return res.status(400).json({ error: 'Unknown role' });
  if (!newPassword || String(newPassword).length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const store = db.get();
  const user = store.users.find((u) => u.role === role);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.passwordHash = bcrypt.hashSync(String(newPassword), 10);
  db.save().then(() => res.json({ ok: true, role }));
});

// Super-only backup: download the entire datastore as one JSON file. This is the
// full store (users/settings/accounts/associates/entries/meta) exactly as held in
// memory — a complete snapshot you can archive or restore from. On the file-store
// deployment (Railway volume) this is the easy off-box backup a database panel
// would otherwise give you.
app.get('/api/backup', auth, requirePerm('canManageClients'), (req, res) => {
  const store = db.get();
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bngm-backup-${stamp}.json"`);
  res.send(JSON.stringify(store, null, 2));
});

// SPA fallback
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- boot ----------
// Idempotent migration: bring an already-seeded datastore up to the current schema
// (new department roles/logins, account active flag, tool date/active fields) without
// wiping existing entries. Safe to run on every start.
const DEFAULT_PASSWORDS = {
  super: 'super123', admin: 'admin123', bizdev: 'bizdev123', seo: 'seo123', content: 'content123',
  social: 'social123', webdev: 'webdev123', perfmkt: 'perfmkt123',
};

// First-ever boot with an empty datastore (e.g. a fresh deploy where `npm run
// seed` was never run). Creates the default role logins plus the app config so
// it is immediately usable and you can log in. When `seed-data.json` is present
// (committed, or provided as a Render Secret File) the real assumptions, months,
// wings, job types, tools and accounts are loaded from it; otherwise we fall back
// to a minimal, non-sensitive placeholder baseline. Team roster + employee
// categories + the client-name list are then merged by migrate() from
// "emp details.txt" / "emp categories.txt" / "clients.txt" when those files exist.
function bootstrapEmptyStore(store) {
  store.users = Object.keys(ROLES).map((role, i) => ({
    id: i + 1,
    role,
    passwordHash: bcrypt.hashSync(DEFAULT_PASSWORDS[role] || role + '123', 10),
  }));

  let seed = null;
  try {
    seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
  } catch { seed = null; }

  if (seed) {
    // Full seed — mirrors src/seed.js so a boot-time seed matches `npm run seed`.
    const toolPool = {};
    for (const m of seed.months) toolPool[m] = 0;
    store.settings = {
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
      toolBudgets: {},
    };
    store.accounts = (seed.accounts || []).map((a, i) => ({
      id: i + 1,
      name: a.name,
      wing: a.wing || '',
      budgetGM: seed.assumptions.gmHealthy,
      active: true,
    }));
    // Fallback roster; migrate() rebuilds this from "emp details.txt" when present.
    store.associates = (seed.associates || []).map((a, i) => {
      const category = roster.normCategory(a.category != null ? a.category : a.type);
      return { id: i + 1, name: a.name, category, type: roster.typeFromCategory(category) };
    });
  } else {
    // Placeholder baseline — NOT the real figures. Edit in Settings → Assumptions.
    // Financial year runs April → March (user, 2026-08-26).
    const months = ['Apr-26', 'May-26', 'Jun-26', 'Jul-26', 'Aug-26', 'Sep-26',
      'Oct-26', 'Nov-26', 'Dec-26', 'Jan-27', 'Feb-27', 'Mar-27'];
    const toolPool = {};
    for (const m of months) toolPool[m] = 0;
    store.settings = {
      assumptions: {
        srRate: 1000, midRate: 750, jrRate: 500,
        srCapacity: 150, jrCapacity: 170, resourceMonthlyHours: 180,
        contingency: 0.05, gmMin: 0.28, gmHealthy: 0.40, fy: 'FY 2026-27',
      },
      months,
      wings: ['Content Creation', 'SEO', 'SMM', 'Web Dev', 'Performance Mktg', 'Guest Posting'],
      jobTypes: ['Content Writing', 'Editing & Proofreading', 'Copywriting', 'Graphic Design',
        'Video Editing', 'Guest Posting', 'Link Building', 'Performance Mktg', 'Web Development', 'Others'],
      toolPool,
      tools: [],
      toolBudgets: {},
    };
    store.accounts = [];
    store.associates = [];
  }

  store.entries = [];
  store.meta = store.meta || {};
}

function migrate() {
  const store = db.get();
  let dirty = false;

  if (!store.users || store.users.length === 0) {
    bootstrapEmptyStore(store);
    dirty = true;
    const src = fs.existsSync(path.join(__dirname, 'seed-data.json')) ? 'seed-data.json' : 'placeholder baseline';
    console.log(`  ✓ first run: seeded 8 role logins + config from ${src} (${store.accounts.length} accounts)`);
  }

  // 1) a login row for every role we now support
  for (const role of Object.keys(ROLES)) {
    if (!store.users.some((u) => u.role === role)) {
      store.users.push({
        id: store.users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1,
        role,
        passwordHash: bcrypt.hashSync(DEFAULT_PASSWORDS[role] || role + '123', 10),
      });
      dirty = true;
      console.log(`  + created login for new role "${role}" (default: ${DEFAULT_PASSWORDS[role]})`);
    }
  }

  // 2) departments/wings exist
  const s = store.settings || (store.settings = {});
  if (!Array.isArray(s.wings)) s.wings = [];
  for (const w of ['Web Dev', 'Performance Mktg']) {
    if (!s.wings.includes(w)) { s.wings.push(w); dirty = true; }
  }

  // 3) accounts have an active flag
  for (const a of store.accounts || []) {
    if (a.active === undefined) { a.active = true; dirty = true; }
  }

  // 4) tools have date + active fields
  for (const t of (s.tools || [])) {
    if (t.active === undefined) { t.active = true; dirty = true; }
    if (t.startDate === undefined) { t.startDate = ''; dirty = true; }
    if (t.stopDate === undefined) { t.stopDate = ''; dirty = true; }
  }

  // 5) per-resource monthly hour cap (default 180)
  if (s.assumptions && s.assumptions.resourceMonthlyHours == null) {
    s.assumptions.resourceMonthlyHours = 180; dirty = true;
  }

  // 6) team roster is email-based (user, 2026-08-17). A datastore seeded before the
  // roster parser understood the current "emp details.txt" layout ends up with
  // garbage placeholder emails (jw101@…). Rebuild it once from the file so every
  // resource carries its real email + inferred seniority, then fall back to the
  // additive sync on later starts so in-app edits survive.
  if (!store.meta) store.meta = {};
  if (!store.meta.rosterEmailV2) {
    roster.emailizeAssociates(store); // fix any legacy name-only rows first
    const n = roster.rebuildAssociatesFromRoster(store);
    store.meta.rosterEmailV2 = true;
    dirty = true;
    if (n) console.log(`  ✓ rebuilt team roster from "emp details.txt" (${n} resources, real emails)`);
  } else {
    const added = roster.syncRosterIntoStore(store);
    if (added) {
      dirty = true;
      console.log(`  + added ${added} resource(s) from "emp details.txt"`);
    }
  }

  // 7) per-department monthly tool budgets (super-only allocation)
  if (!s.toolBudgets || typeof s.toolBudgets !== 'object') { s.toolBudgets = {}; dirty = true; }

  // 8) tools carry a "common" flag (shared across all departments) and, for common
  // tools, a per-department cost split (`deptCosts`).
  for (const t of (s.tools || [])) {
    if (t.common === undefined) { t.common = false; dirty = true; }
    if (t.deptCosts === undefined) { t.deptCosts = {}; dirty = true; }
  }

  // 9) three employee categories (user, 2026-08-21). Add a Middle ₹/hr rate tier
  // (default = midway between Senior & Junior) and stamp every resource with its
  // category from "emp categories.txt" (falls back to one inferred from its type).
  if (s.assumptions && s.assumptions.midRate == null) {
    const sr = compute.num(s.assumptions.srRate);
    const jr = compute.num(s.assumptions.jrRate);
    s.assumptions.midRate = sr && jr ? Math.round((sr + jr) / 2) : 950;
    dirty = true;
    console.log(`  ✓ added Middle rate tier (₹${s.assumptions.midRate}/hr) — edit in Assumptions`);
  }
  // First run: the file is authoritative for every resource. Afterwards only fill
  // in resources that still have no category, so in-app "Manage team" edits stick.
  let catChanged;
  if (!store.meta.categoriesV1) {
    catChanged = roster.applyCategoriesToStore(store);
    store.meta.categoriesV1 = true;
    dirty = true;
    console.log(`  ✓ applied employee categories to ${catChanged} resource(s) from "emp categories.txt"`);
  } else {
    catChanged = roster.applyCategoriesToStore(store, { onlyMissing: true });
    if (catChanged) { dirty = true; console.log(`  + set category on ${catChanged} new resource(s)`); }
  }

  // 9b) every resource carries a human-readable name (user, 2026-09-09). Datastores
  // seeded before this stored only the email, so the resource picker could not be
  // searched or shown by name. Backfill `fullName` from the roster file (by email),
  // falling back to a name derived from the email. Additive — never clears a name.
  const namesSet = roster.applyNamesToStore(store);
  if (namesSet) {
    dirty = true;
    console.log(`  ✓ set display name on ${namesSet} resource(s)`);
  }

  // 10) merge the client list from "clients.txt" (Book1) into accounts, additively.
  const clientsAdded = clients.syncClientsIntoStore(store);
  if (clientsAdded) {
    dirty = true;
    console.log(`  + added ${clientsAdded} client(s) from "clients.txt"`);
  }

  if (dirty) db.save().then(() => console.log('  ✓ datastore migrated to current schema'));
}

// Connect to MySQL and load the store BEFORE serving any request, then run the
// idempotent schema migration and start listening.
db.init()
  .then(() => {
    migrate();
    fx.warm(); // begin fetching the USD→INR rate in the background so the first load is fast
    app.listen(PORT, () => {
      console.log(`\nJW BNGM Tracker running →  http://localhost:${PORT}\n`);
    });
  })
  .catch((err) => {
    const driver = db.driver();
    if (driver === 'firestore') {
      console.error('\n✖ Could not connect to Firestore.');
      console.error('  Check FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)');
      console.error('  and that the Firestore database has been created for this project.');
    } else if (driver === 'mysql') {
      const cfg = db.dbConfig();
      console.error('\n✖ Could not connect to the MySQL database.');
      console.error(`  Tried ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
      console.error('  Check your DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME (.env or environment).');
    } else {
      console.error('\n✖ Could not initialise the datastore.');
    }
    console.error(`  ${err.code || ''} ${err.message}\n`);
    process.exit(1);
  });
