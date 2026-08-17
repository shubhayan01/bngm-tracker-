const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./src/db');
const { ROLES, signToken, verifyToken, roleCanSeeWing, visibleWings } = require('./src/auth');
const compute = require('./src/compute');
const fx = require('./src/fx');
const roster = require('./src/roster');

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
    tools: s.tools || [],
    fx: { rate: rate.rate, live: rate.live, at: rate.at },
    toolPool: req.roleDef.canEditSettings ? s.toolPool : undefined,
  });
});

// ---------- live USD→INR rate ----------
app.get('/api/fx', auth, async (req, res) => {
  const rate = await fx.getRate(req.query.refresh === '1');
  res.json({ rate: rate.rate, live: rate.live, at: rate.at });
});

// ---------- accounts ----------
app.post('/api/accounts', auth, requirePerm('canCreateAccounts'), (req, res) => {
  const { name, wing, budgetGM } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Account name required' });
  let finalWing = wing || '';
  // Departments can only create within a wing they own.
  if (req.roleDef.wings !== '*') {
    if (!roleCanSeeWing(req.role, finalWing)) finalWing = req.roleDef.wings[0] || '';
    // A role with no wings assigned can't own an account anywhere.
    if (!Array.isArray(req.roleDef.wings) || req.roleDef.wings.length === 0) {
      return res.status(403).json({ error: 'Your role has no wing assigned — ask Super to assign one.' });
    }
  }
  const store = db.get();
  const acc = {
    id: db.nextId('accounts'),
    name: String(name).trim(),
    wing: finalWing,
    budgetGM: budgetGM != null ? Number(budgetGM) : settings().assumptions.gmHealthy,
    active: (req.body || {}).active != null ? !!req.body.active : true,
  };
  store.accounts.push(acc);
  db.save().then(() => res.json(acc));
});

app.put('/api/accounts/:id', auth, requireWrite, (req, res) => {
  const id = Number(req.params.id);
  const store = db.get();
  const acc = store.accounts.find((a) => a.id === id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!canEditAccount(req.role, acc)) return res.status(403).json({ error: 'Not your account' });
  const { name, wing, budgetGM, active } = req.body || {};
  if (name != null) acc.name = String(name).trim();
  if (budgetGM != null) acc.budgetGM = Number(budgetGM);
  if (active != null) acc.active = !!active;
  // only roles that can see the target wing may move an account into it
  if (wing != null && roleCanSeeWing(req.role, wing)) acc.wing = wing;
  db.save().then(() => res.json(acc));
});

// ---------- tools catalog ----------
// Everyone signed in can view; Super & BizDev (canManageTools) can edit.
function nextToolId() {
  const t = settings().tools || [];
  return t.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}
function cleanDate(v) {
  if (v == null || v === '') return '';
  const s = String(v).slice(0, 10); // YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function cleanTool(b, base = {}) {
  return {
    ...base,
    name: b.name != null ? String(b.name).trim() : base.name || '',
    description: b.description != null ? String(b.description) : base.description || '',
    cost: b.cost != null ? compute.num(b.cost) : base.cost || 0,
    currency: b.currency === 'INR' ? 'INR' : b.currency === 'USD' ? 'USD' : base.currency || 'USD',
    department: b.department != null ? String(b.department) : base.department || 'General',
    why: b.why != null ? String(b.why) : base.why || '',
    startDate: b.startDate != null ? cleanDate(b.startDate) : base.startDate || '',
    stopDate: b.stopDate != null ? cleanDate(b.stopDate) : base.stopDate || '',
    active: b.active != null ? !!b.active : base.active !== undefined ? base.active : true,
  };
}

app.get('/api/tools', auth, (req, res) => {
  res.json(settings().tools || []);
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
// Only settings-capable roles (Super) may add / adjust seniority.
function normType(t) {
  return String(t || '').toLowerCase().startsWith('jr') || /junior/i.test(String(t))
    ? 'Jr. Resource'
    : 'Sr. Resource';
}

app.get('/api/associates', auth, (req, res) => {
  res.json(db.get().associates || []);
});

app.post('/api/associates', auth, requirePerm('canEditSettings'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name required' });
  const store = db.get();
  const a = { id: db.nextId('associates'), name: String(b.name).trim(), type: normType(b.type) };
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
  if (b.type != null) a.type = normType(b.type);
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
    jrHrs: 0,
    srHrsPlan: 0,
    jrHrsPlan: 0,
    resourcesActual: [], // [{ id, hours }] per named employee
    resourcesPlan: [],
    outsourcing: [],
    wcPlanned: 0,
    wcDelivered: 0,
    notes: '',
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
  if (!settings().months.includes(month)) return res.status(400).json({ error: 'Unknown month' });

  const assocById = Object.fromEntries((store.associates || []).map((a) => [a.id, a]));
  const isSenior = (a) => a && !String(a.type || '').toLowerCase().startsWith('jr') && !/junior/i.test(String(a && a.type));
  const cleanResources = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((r) => ({ id: Number(r.id), hours: compute.num(r.hours) }))
      .filter((r) => r.id && r.hours > 0);
  const sumByType = (arr) => {
    let sr = 0, jr = 0;
    for (const r of arr) (isSenior(assocById[r.id]) ? (sr += r.hours) : (jr += r.hours));
    return { sr, jr };
  };

  // Clean + capacity-check the per-person breakdown BEFORE mutating anything, so a
  // rejected save leaves the datastore untouched. A resource can't exceed its
  // monthly hour cap across all clients (this account's own hours are excluded).
  const cap = resourceCapacity();
  const checkCapacity = (arr, m) => {
    const other = resourceMonthUsage(month, m, accountId);
    for (const r of arr) {
      if ((other[r.id] || 0) + r.hours > cap) {
        const nm = (assocById[r.id] && assocById[r.id].name) || ('#' + r.id);
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
  const numFields = ['revPlanned', 'revActual', 'srHrs', 'jrHrs', 'srHrsPlan', 'jrHrsPlan', 'wcPlanned', 'wcDelivered'];
  for (const f of numFields) if (b[f] != null) entry[f] = compute.num(b[f]);

  // Only apply a breakdown when a non-empty one was sent, so legacy entries that
  // only carry aggregate srHrs/jrHrs are never clobbered by an empty array.
  if (cleanAct) {
    entry.resourcesActual = cleanAct;
    const t = sumByType(cleanAct);
    entry.srHrs = t.sr; entry.jrHrs = t.jr;
  }
  if (cleanPlan) {
    entry.resourcesPlan = cleanPlan;
    const t = sumByType(cleanPlan);
    entry.srHrsPlan = t.sr; entry.jrHrsPlan = t.jr;
  }
  if (Array.isArray(b.outsourcing)) {
    entry.outsourcing = b.outsourcing
      .filter((o) => o && (o.jobType || o.cost))
      .map((o) => ({ jobType: String(o.jobType || 'Others'), cost: compute.num(o.cost), vendor: String(o.vendor || '') }));
  }
  if (b.notes != null) entry.notes = String(b.notes);
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

  res.json({ mode, months: s.months, ytd, monthly, wingSummary, ranking, comparison, comparisonYtd });
});

function aggregate(rows, a) {
  const sum = (f) => rows.reduce((s, r) => s + r.c[f], 0);
  const revenue = sum('revenue');
  const manpower = sum('manpower');
  const outsourcing = sum('outsourcing');
  const toolShare = sum('toolShare');
  const contingency = sum('contingency');
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
    revenue, manpower, outsourcing, toolShare, contingency, totalCost, grossProfit, gm,
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
  for (const k of ['srRate', 'jrRate', 'srCapacity', 'jrCapacity', 'resourceMonthlyHours', 'contingency', 'gmMin', 'gmHealthy']) {
    if (b[k] != null) s.assumptions[k] = compute.num(b[k]);
  }
  if (b.fy != null) s.assumptions.fy = String(b.fy);
  db.save().then(() => res.json(s.assumptions));
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
function migrate() {
  const store = db.get();
  if (!store.users || store.users.length === 0) {
    console.log('\n⚠  No users found. Run `npm run seed` first to load data + create logins.\n');
    return;
  }
  let dirty = false;

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

  // 6) switch the team roster from names to emails (user, 2026-08-17): convert any
  // legacy name-based associate to a placeholder email in place (keeps ids so
  // existing entries still resolve). Safe to run repeatedly — no-ops once emailed.
  const emailed = roster.emailizeAssociates(store);
  if (emailed) {
    dirty = true;
    console.log(`  + converted ${emailed} team member(s) from name → placeholder email`);
  }

  // 7) sync the team roster from `emp details.txt` (adds new hires; never wipes)
  const added = roster.syncRosterIntoStore(store);
  if (added) {
    dirty = true;
    console.log(`  + added ${added} resource(s) from "emp details.txt"`);
  }

  if (dirty) db.save().then(() => console.log('  ✓ datastore migrated to current schema'));
}
migrate();

app.listen(PORT, () => {
  console.log(`\nJW BNGM Tracker running →  http://localhost:${PORT}\n`);
});
