// ---------------- state & helpers ----------------
const state = {
  token: localStorage.getItem('bngm_token') || null,
  roleInfo: null,
  boot: null, // accounts, associates, assumptions, months, wings, jobTypes, tools, fx
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const pct = (n) => (Number(n) * 100).toFixed(1) + '%';

// A focused <input type=number> changes its value on mouse-wheel, so scrolling the
// page was silently nudging figures. Blur the field on wheel — the page still
// scrolls, but the number is left alone (user, 2026-08-26).
document.addEventListener('wheel', () => {
  const a = document.activeElement;
  if (a && a.tagName === 'INPUT' && a.type === 'number') a.blur();
}, { passive: true });

// ---- live USD conversion (rate fetched from server / frankfurter.app) ----
const fxRate = () => (state.boot && state.boot.fx && Number(state.boot.fx.rate)) || 87;
const usd = (inrAmt) => {
  const v = (Number(inrAmt) || 0) / fxRate();
  const digits = v > 0 && v < 10 ? 2 : 0; // keep small amounts readable
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: digits });
};
// INR figure; the USD conversion is hidden by default and revealed on hover
// or globally via the "$" toggle in the topbar (body.show-usd).
const inrUsd = (n) => `<span class="inr-cell" title="≈ ${usd(n)}">${inr(n)}<span class="usd">≈ ${usd(n)}</span></span>`;

// USD visibility toggle
function initUsdToggle() {
  const on = localStorage.getItem('bngm_usd') === '1';
  document.body.classList.toggle('show-usd', on);
  const btn = document.getElementById('usdToggle');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.onclick = () => {
      const now = !document.body.classList.contains('show-usd');
      document.body.classList.toggle('show-usd', now);
      btn.classList.toggle('active', now);
      localStorage.setItem('bngm_usd', now ? '1' : '0');
    };
  }
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch('/api' + path, { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------------- theme ----------------
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('bngm_theme', t);
  const icon = t === 'dark' ? '☀️' : '🌙';
  $$('.theme-toggle').forEach((b) => (b.textContent = icon));
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  setTheme(cur === 'dark' ? 'light' : 'dark');
}
(function initTheme() {
  const saved = localStorage.getItem('bngm_theme');
  const sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  setTheme(saved || sys);
})();
$('#themeToggle').addEventListener('click', toggleTheme);
$('#themeToggleLogin').addEventListener('click', toggleTheme);

// ---------------- fx badge ----------------
function renderFx() {
  const b = $('#fxBadge');
  if (!state.boot || !state.boot.fx) { b.textContent = ''; return; }
  const f = state.boot.fx;
  b.innerHTML = `1 USD = <b>₹${Number(f.rate).toFixed(2)}</b> <span class="${f.live ? 'live' : 'cached'}">${f.live ? '↻ live' : '• cached'}</span>`;
  b.title = 'Live USD → INR rate — click to refresh';
}
$('#fxBadge').addEventListener('click', async () => {
  try {
    const f = await api('/fx?refresh=1');
    state.boot.fx = f; renderFx(); toast('Rate refreshed');
    if (!$('#view-dashboard').classList.contains('hidden')) loadDashboard();
    if (!$('#view-tools').classList.contains('hidden')) renderTools();
  } catch (e) { toast(e.message); }
});

// ---------------- auth ----------------
$('#loginBtn').addEventListener('click', doLogin);
$('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const role = $('#loginRole').value;
  const password = $('#loginPassword').value;
  $('#loginError').textContent = '';
  try {
    const r = await api('/login', { method: 'POST', body: JSON.stringify({ role, password }) });
    state.token = r.token; localStorage.setItem('bngm_token', r.token);
    await startApp();
  } catch (e) { $('#loginError').textContent = e.message; }
}

function logout() {
  state.token = null; localStorage.removeItem('bngm_token');
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#loginPassword').value = '';
  const fab = $('#helpFab'); if (fab) fab.classList.add('hidden');
  const hp = $('#helpPanel'); if (hp) hp.classList.add('hidden');
}
$('#logoutBtn').addEventListener('click', logout);

async function startApp() {
  state.boot = await api('/bootstrap');
  state.roleInfo = state.boot.roleInfo;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#roleBadge').textContent = state.roleInfo.label;
  $('#fyBadge').textContent = state.boot.assumptions.fy || '';
  renderFx();
  initUsdToggle();
  updateHelpFab();
  $$('.settings-only').forEach((e) => e.classList.toggle('hidden', !state.roleInfo.canEditSettings));
  $('#addToolBtn').classList.toggle('hidden', !state.roleInfo.canManageTools);

  // Read-only roles (Admin) get reports only — hide the Update tab and any
  // create buttons, and land on the dashboard.
  const ro = !!state.roleInfo.readOnly;
  $$('#tabs .tab[data-view="entry"]').forEach((t) => t.classList.toggle('hidden', ro));
  $('#addAccountBtn').classList.toggle('hidden', ro || !state.roleInfo.canCreateAccounts);

  // Opened as a detail tab (?view=detail…)? Show that breakdown instead of the normal
  // landing view — the drill-down works for every role that can see the data.
  if (maybeOpenDetail()) return;
  if (ro) { switchView('dashboard'); return; }

  switchView('entry');
  startEntry();
}

// ---------------- nav ----------------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab'); if (!btn) return;
  switchView(btn.dataset.view);
});
const _detailBack = $('#detailBack');
if (_detailBack) _detailBack.addEventListener('click', () => switchView('dashboard'));

function switchView(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  if (view === 'entry') startEntry();
  if (view === 'dashboard') loadDashboard();
  if (view === 'accounts') renderAccounts();
  if (view === 'tools') renderTools();
  if (view === 'settings') renderSettings();
}

// ================= ENTRY (single-screen form) =================
// Flow: pick client → Planned/Actual → fill everything on one screen. All fields
// stay editable (fix mistakes any time); pick an existing client+month to edit it.
const entry = { accountId: null, clientName: null, month: null, mode: 'actual', data: null };

// ---- dynamic month keys (user, 2026-08-21) ----
// Entry date is now a free Year + Month pick, combined into a "Mon-YY" key. Any
// new Month-Year the user picks is created on the server on save.
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthKey(monIdx, year) { return `${MONTHS3[monIdx]}-${String(year).slice(2)}`; }
function parseMonthKey(key) {
  const m = /^([A-Za-z]{3})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const i = MONTHS3.indexOf(m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase());
  if (i < 0) return null;
  return { monIdx: i, year: 2000 + Number(m[2]) };
}
// Unique client names → their accounts (one per service/department wing).
function clientGroups() {
  const map = new Map();
  for (const a of activeAccounts()) {
    if (!map.has(a.name)) map.set(a.name, []);
    map.get(a.name).push(a);
  }
  return map;
}
function yearRange() {
  const now = new Date().getFullYear();
  const ys = new Set();
  for (const m of (state.boot.months || [])) { const p = parseMonthKey(m); if (p) ys.add(p.year); }
  for (let y = now - 1; y <= now + 2; y++) ys.add(y);
  return [...ys].sort((a, b) => a - b);
}

const F = () => entry.mode === 'planned'
  ? { rev: 'revPlanned', wc: 'wcPlanned', res: 'resourcesPlan', out: 'outsourcingPlan', notes: 'notesPlan' }
  : { rev: 'revActual', wc: 'wcDelivered', res: 'resourcesActual', out: 'outsourcingActual', notes: 'notesActual' };

// Three employee categories (user, 2026-08-21): Senior / Middle / Junior — each
// drives its own ₹/hr rate tier.
const CATEGORIES = ['Senior', 'Middle', 'Junior'];
function categoryOf(assoc) {
  const raw = String((assoc && (assoc.category != null ? assoc.category : assoc.type)) || '').toLowerCase();
  if (raw.startsWith('sen') || raw.startsWith('sr')) return 'Senior';
  if (raw.startsWith('jun') || raw.startsWith('jr')) return 'Junior';
  if (raw.startsWith('mid')) return 'Middle';
  return 'Middle';
}
function rateFor(assoc) {
  const a = state.boot.assumptions;
  const cat = categoryOf(assoc);
  if (cat === 'Senior') return Number(a.srRate) || 0;
  if (cat === 'Junior') return Number(a.jrRate) || 0;
  return a.midRate != null ? Number(a.midRate) : Math.round(((Number(a.srRate) || 0) + (Number(a.jrRate) || 0)) / 2);
}
function isSenior(assoc) { return categoryOf(assoc) === 'Senior'; }
// Small coloured pill for a resource's category, with its ₹/hr rate in the title.
// Seniority is backend-only for everyone except Super Admin — regular users must not
// see the Senior / Middle / Junior tags (user, 2026-08-24).
function catTag(assoc) {
  if (!isSuper()) return '';
  const cat = categoryOf(assoc);
  return `<span class="cat-tag cat-${cat.toLowerCase()}" title="${cat} · ₹${rateFor(assoc)}/hr">${cat}</span>`;
}
// All clients visible to this role (the "active/inactive" flag was removed — user 2026-08-21).
function activeAccounts() {
  return state.boot.accounts || [];
}
function isSuper() { return !!state.roleInfo.canManageClients; }
function entryHint() {
  $('#entryBody').innerHTML = '<p class="muted entry-hint">Pick a client, service, year and month above to begin — then everything is one screen.</p>';
  renderPreview();
}

function startEntry() {
  const groups = clientGroups();
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const clientSel = $('#e_client');
  // Client picker shows client NAMES only — no department (user, 2026-08-21).
  clientSel.innerHTML = '<option value="">— select client —</option>' +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (entry.clientName && groups.has(entry.clientName)) clientSel.value = entry.clientName;
  else { entry.clientName = null; entry.accountId = null; }

  fillServiceSelect();
  fillDateSelects();
  setModeButtons();

  clientSel.onchange = () => {
    entry.clientName = clientSel.value || null;
    entry.accountId = null;
    fillServiceSelect();
    afterHeadChange();
  };
  $('#e_service').onchange = () => onServiceChange();
  $('#e_year').onchange = () => { rebuildMonth(); afterHeadChange(); };
  $('#e_monthName').onchange = () => { rebuildMonth(); afterHeadChange(); };
  $$('#e_mode button').forEach((b) => (b.onclick = () => { entry.mode = b.dataset.mode; setModeButtons(); afterHeadChange(); }));

  afterHeadChange();
  const sfClear = $('#sfClear');
  if (sfClear) sfClear.onclick = () => { state.saveFeed = []; renderSaveFeed(); };
  renderSaveFeed();
}

// Live "recent updates" feed (user, 2026-08-26). Each saved entry is logged above the
// live costing panel — client name, month/mode, planned & actual revenue — so a long
// data-entry session (e.g. 25 clients back to back) shows exactly what has gone in.
function renderSaveFeed() {
  const wrap = $('#saveFeed'); const list = $('#saveFeedList');
  if (!wrap || !list) return;
  const items = state.saveFeed || [];
  wrap.classList.toggle('hidden', !items.length);
  list.innerHTML = items.map((it) => `
    <div class="sf-item">
      <div class="sf-top"><span class="sf-name">${esc(it.name)}${it.wing ? ` <span class="muted small">· ${esc(it.wing)}</span>` : ''}</span><span class="sf-when">${esc(it.month)} · ${it.mode === 'planned' ? 'Plan' : 'Actual'}</span></div>
      <div class="sf-figs"><span>Plan rev <b>${inr(it.planRev)}</b></span><span>Actual rev <b>${inr(it.actualRev)}</b></span></div>
    </div>`).join('');
}
function logSaveFeed() {
  const acc = state.boot.accounts.find((a) => a.id === entry.accountId);
  state.saveFeed = state.saveFeed || [];
  state.saveFeed.unshift({
    name: entry.clientName || (acc && acc.name) || '—',
    wing: acc ? acc.wing : '',
    month: entry.month,
    mode: entry.mode,
    planRev: Number(entry.data.revPlanned) || 0,
    actualRev: Number(entry.data.revActual) || 0,
    at: Date.now(),
  });
  state.saveFeed = state.saveFeed.slice(0, 40);
  renderSaveFeed();
}

// Populate the Service / Department select from the chosen client.
//  • Super sees EVERY department: existing ones select their account, missing ones
//    carry a "new:<wing>" sentinel that creates the account on selection.
//  • Department roles see only the department(s) that client is in (their own).
function fillServiceSelect() {
  const sel = $('#e_service');
  if (!entry.clientName) { sel.innerHTML = '<option value="">—</option>'; sel.disabled = true; entry.accountId = null; return; }
  const accs = clientGroups().get(entry.clientName) || [];
  const byWing = {};
  accs.forEach((a) => { byWing[a.wing || ''] = a; });
  sel.disabled = false;

  // "Unassigned" (empty-wing) accounts are no longer offered here (user, 2026-08-24) —
  // an entry is always logged against a real department. Super sees every department
  // (existing ones select the account, missing ones carry a "new:<wing>" add sentinel).
  const opts = [];
  if (isSuper()) {
    (state.boot.wings || []).forEach((w) => {
      if (byWing[w]) opts.push(`<option value="${byWing[w].id}">${esc(w)}</option>`);
      else opts.push(`<option value="new:${esc(w)}">${esc(w)}</option>`);
    });
  } else {
    accs.filter((a) => a.wing).forEach((a) => opts.push(`<option value="${a.id}">${esc(a.wing)}</option>`));
    if (!opts.length) opts.push('<option value="">—</option>');
  }
  sel.innerHTML = opts.join('');

  // Only auto-select accounts that actually have a department row rendered above.
  const pickable = isSuper() ? accs.filter((a) => a.wing) : accs.filter((a) => a.wing);
  if (entry.accountId && pickable.some((a) => a.id === entry.accountId)) sel.value = String(entry.accountId);
  else if (pickable.length) { entry.accountId = pickable[0].id; sel.value = String(pickable[0].id); }
  else { entry.accountId = null; if (sel.options[0]) sel.value = sel.options[0].value; }
}

// Handle a service pick — including the Super-only "add this department" sentinel,
// which creates the (client, department) account before loading the entry.
async function onServiceChange() {
  const v = $('#e_service').value;
  if (v && v.startsWith('new:')) {
    const wing = v.slice(4);
    try {
      const acc = await api('/accounts', { method: 'POST', body: JSON.stringify({ name: entry.clientName, wing }) });
      state.boot = await api('/bootstrap'); // pick up the new account everywhere
      entry.accountId = acc.id;
      fillServiceSelect();
      toast(`${entry.clientName} added to ${wing}`);
    } catch (e) { toast(e.message); return; }
  } else {
    entry.accountId = Number(v) || null;
  }
  afterHeadChange();
}

function fillDateSelects() {
  const yearSel = $('#e_year');
  const monSel = $('#e_monthName');
  const years = yearRange();
  yearSel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  monSel.innerHTML = MONTHS_FULL.map((m, i) => `<option value="${i}">${m}</option>`).join('');
  const now = new Date();
  let cur = parseMonthKey(entry.month) || { monIdx: now.getMonth(), year: now.getFullYear() };
  if (!years.includes(cur.year)) cur.year = years.includes(now.getFullYear()) ? now.getFullYear() : years[years.length - 1];
  yearSel.value = String(cur.year);
  monSel.value = String(cur.monIdx);
  entry.month = monthKey(cur.monIdx, cur.year);
}

function rebuildMonth() {
  const y = Number($('#e_year').value);
  const mi = Number($('#e_monthName').value);
  entry.month = monthKey(mi, y);
}

function afterHeadChange() {
  if (entry.accountId && entry.month) loadEntry();
  else entryHint();
}

function setModeButtons() {
  $$('#e_mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === entry.mode));
}

async function loadEntry() {
  if (!entry.accountId || !entry.month) return;
  const r = await api(`/entry?accountId=${entry.accountId}&month=${encodeURIComponent(entry.month)}&mode=${entry.mode}`);
  entry.data = r.entry;
  entry.capacity = r.capacity || 180;
  entry.usageOther = r.usageOther || {}; // hours booked on OTHER clients this month, per resource id
  normalizeEntryData(entry.data);
  renderEntryBody();
}

// Fill in any missing arrays / split fields on a loaded or just-saved entry.
// Outsourcing & notes are split Plan vs Actual (user, 2026-08-24); each mode's field
// is seeded from the legacy shared field so pre-split entries stay editable and their
// planned outsourcing / notes still surface in the Actual reference block.
function normalizeEntryData(d) {
  d.resourcesActual = Array.isArray(d.resourcesActual) ? d.resourcesActual : [];
  d.resourcesPlan = Array.isArray(d.resourcesPlan) ? d.resourcesPlan : [];
  const legacyOut = Array.isArray(d.outsourcing) ? d.outsourcing : [];
  d.outsourcing = legacyOut;
  d.outsourcingPlan = Array.isArray(d.outsourcingPlan) ? d.outsourcingPlan : legacyOut.slice();
  d.outsourcingActual = Array.isArray(d.outsourcingActual) ? d.outsourcingActual : legacyOut.slice();
  const legacyNotes = d.notes || '';
  d.notesPlan = d.notesPlan != null ? d.notesPlan : legacyNotes;
  d.notesActual = d.notesActual != null ? d.notesActual : legacyNotes;
}

// "X of 180 hrs free" label for a resource, given hours used on other clients and
// the hours currently typed for this client.
function availLabel(usedElsewhere, current, cap) {
  const free = Math.max(0, cap - usedElsewhere - current);
  const base = `${free} of ${cap} hrs free`;
  return usedElsewhere > 0 ? `${base} · ${usedElsewhere} on other clients` : base;
}

// ---- resource helpers (per-employee hours for the current mode) ----
function resArr() { entry.data[F().res] = entry.data[F().res] || []; return entry.data[F().res]; }
function resHours(id) { const r = resArr().find((x) => Number(x.id) === id); return r ? r.hours : 0; }
function setRes(id, hours) {
  const arr = resArr();
  const r = arr.find((x) => Number(x.id) === id);
  if (hours > 0) { if (r) r.hours = hours; else arr.push({ id, hours }); }
  else if (r) arr.splice(arr.indexOf(r), 1);
}
function assocById(id) { return (state.boot.associates || []).find((a) => a.id === Number(id)); }

// Planned hours booked for a resource (reference shown while filling Actuals).
function plannedHoursFor(id) {
  const r = (entry.data.resourcesPlan || []).find((x) => Number(x.id) === Number(id));
  return r ? Number(r.hours) || 0 : 0;
}
// Asana report URL for a resource — we identify people by email, which Asana search
// resolves to their tasks/assignments.
function asanaUrl(email) {
  return 'https://app.asana.com/0/search?q=' + encodeURIComponent(String(email || ''));
}
function openAsana(id) {
  const a = assocById(id);
  const email = a ? a.name : '';
  if (!email) { toast('No email for this resource'); return; }
  window.open(asanaUrl(email), '_blank', 'noopener');
}

// Planned-vs-actual reference block: while filling ACTUALS, show what was planned
// for this same client + month (user, 2026-08-21).
function plannedRefBlock() {
  if (entry.mode !== 'actual') return '';
  const d = entry.data;
  const planRev = Number(d.revPlanned) || 0;
  const planRes = d.resourcesPlan || [];
  const planOut = d.outsourcingPlan || [];
  const planNotes = (d.notesPlan || '').trim();
  if (!planRev && !planRes.length && !planOut.length && !planNotes) return '';
  const resLines = planRes.length
    ? planRes.map((r) => {
      const a = assocById(r.id);
      const nm = a ? a.name : ('#' + r.id);
      return `<div class="pr-line"><span>${esc(nm)}${a ? ' ' + catTag(a) : ''}</span><span class="val">${r.hours} hr planned</span></div>`;
    }).join('')
    : '<div class="muted small">No resources were planned.</div>';
  const outBlock = planOut.length ? `
    <div class="pr-sub">Planned outsourcing</div>
    ${planOut.map((o) => `<div class="pr-line"><span>${esc(o.jobType || 'Others')}</span><span class="val">${inr(o.cost)}</span></div>`).join('')}` : '';
  const notesBlock = planNotes ? `
    <div class="pr-sub">Planned notes</div>
    <div class="pr-line"><span class="pr-notes">${esc(planNotes)}</span></div>` : '';
  return `<div class="planned-ref">
    <div class="pr-head">📋 Planned reference — what you budgeted for this client &amp; month</div>
    <div class="pr-line"><span>Planned revenue</span><span class="val">${inr(planRev)}</span></div>
    <div class="pr-sub">Planned resources &amp; expected hours</div>
    ${resLines}
    ${outBlock}
    ${notesBlock}
    <p class="muted small" style="margin:8px 0 0">These are your plan figures — now enter the <b>actual</b> hours each person really did below.</p>
  </div>`;
}

// Render the resources the user has picked (booked or just added) as hour rows.
// The full member list is intentionally NOT shown — resources are added by
// searching an email above.
function renderResRows() {
  const cont = $('#e_resRows');
  if (!cont) return;
  const cap = entry.capacity || 180;
  const usageOther = entry.usageOther || {};
  const ids = [...(entry.picked || new Set())];
  if (!ids.length) {
    cont.innerHTML = '<p class="muted small">No resources added yet — search an email above to add one.</p>';
    return;
  }
  const showPlan = entry.mode === 'actual';
  cont.innerHTML = ids.map((id) => {
    const a = assocById(id);
    const email = a ? a.name : ('#' + id);
    const used = usageOther[id] || 0;
    const cur = resHours(id) || 0;
    const maxForThis = Math.max(0, cap - used);
    const full = cap - used - cur <= 0;
    const ph = showPlan ? plannedHoursFor(id) : 0;
    const planTag = showPlan && ph ? `<span class="res-plan" title="Hours expected during planning">expected ${ph} hr</span>` : '';
    return `
    <label class="res-row ${full ? 'res-full' : ''}" data-id="${id}">
      <span class="res-name">${esc(email)}${a ? ' ' + catTag(a) : ' <span class="muted small">(removed)</span>'}${planTag}</span>
      <input type="number" min="0" max="${maxForThis}" step="1" class="res-hrs" data-id="${id}"
             value="${cur || ''}" placeholder="${showPlan && ph ? ph + ' hrs?' : '0 hrs'}" />
      <span class="res-avail muted">${availLabel(used, cur, cap)}</span>
      <button type="button" class="btn btn-sm btn-ghost res-asana" data-id="${id}" title="Open Asana report for ${esc(email)}">📋 Asana</button>
      <button type="button" class="btn btn-sm btn-danger res-del" data-id="${id}" title="Remove">✕</button>
    </label>`;
  }).join('');

  const cap2 = cap;
  $$('.res-hrs', cont).forEach((inp) => (inp.oninput = () => {
    const id = Number(inp.dataset.id);
    const used = usageOther[id] || 0;
    const maxForThis = Math.max(0, cap2 - used);
    let v = Number(inp.value) || 0;
    if (v < 0) v = 0;
    if (v > maxForThis) { v = maxForThis; inp.value = v; toast(`Only ${maxForThis} hr free for this resource in ${entry.month}`); }
    setRes(id, v);
    const row = inp.closest('.res-row');
    const lbl = row && row.querySelector('.res-avail');
    if (lbl) lbl.textContent = availLabel(used, v, cap2);
    if (row) row.classList.toggle('res-full', cap2 - used - v <= 0);
    renderPreview();
  }));
  $$('.res-asana', cont).forEach((b) => (b.onclick = (ev) => { ev.preventDefault(); openAsana(Number(b.dataset.id)); }));
  $$('.res-del', cont).forEach((b) => (b.onclick = () => {
    const id = Number(b.dataset.id);
    setRes(id, 0);
    if (entry.picked) entry.picked.delete(id);
    renderResRows();
    renderPreview();
  }));
}

// Email search that adds a resource row when a match is clicked.
function wireResSearch() {
  const inp = $('#e_resSearch');
  const box = $('#e_resMatches');
  if (!inp || !box) return;
  const close = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    if (!q) { close(); return; }
    const picked = entry.picked || new Set();
    const matches = (state.boot.associates || [])
      .filter((a) => !picked.has(a.id) && String(a.name || '').toLowerCase().includes(q))
      .slice(0, 8);
    if (!matches.length) {
      box.innerHTML = `<div class="res-match muted">No team email matches “${esc(inp.value)}”. Add them in Manage team.</div>`;
      box.classList.remove('hidden');
      return;
    }
    box.innerHTML = matches.map((a) =>
      `<div class="res-match" data-id="${a.id}">${esc(a.name)} ${catTag(a)}</div>`).join('');
    box.classList.remove('hidden');
    $$('.res-match[data-id]', box).forEach((m) => (m.onclick = () => {
      const id = Number(m.dataset.id);
      if (!entry.picked) entry.picked = new Set();
      entry.picked.add(id);
      inp.value = ''; close();
      renderResRows(); renderPreview();
    }));
  };
  inp.onblur = () => setTimeout(close, 150); // let a match click register first
}

function renderEntryBody() {
  const acc = state.boot.accounts.find((a) => a.id === entry.accountId);
  const f = F();
  const canManageTeam = state.roleInfo.canEditSettings;
  const exists = !!entry.data.id;
  const cap = entry.capacity || 180;
  // Which resources are shown as rows right now = the ones already booked plus any
  // the user has just picked from the email search (even before typing hours). While
  // filling Actuals, also surface everyone who was in the plan so their real hours
  // can be entered against the expected ones (user, 2026-08-21).
  entry.picked = new Set((resArr() || []).map((r) => Number(r.id)));
  if (entry.mode === 'actual') {
    for (const r of (entry.data.resourcesPlan || [])) entry.picked.add(Number(r.id));
  }

  const body = `
    ${exists ? `<div class="entry-flag">✎ Editing existing ${entry.mode} numbers — adjust anything and save.</div>` : ''}
    ${plannedRefBlock()}

    <div class="entry-field">
      <label class="ef-label">Revenue (₹) — ${entry.mode === 'planned' ? 'planned / budget' : 'actual billed'}</label>
      <input id="e_rev" type="number" min="0" step="1" value="${entry.data[f.rev] || ''}" placeholder="e.g. 185000" />
      <div class="usd-hint usd">≈ <span id="e_rev_usd"></span></div>
    </div>

    <div class="entry-field">
      <div class="ef-head">
        <label class="ef-label">Resources (${entry.mode} hours)</label>
        ${canManageTeam ? `<button type="button" id="e_manageTeam" class="btn btn-sm btn-ghost" title="Add or adjust each resource's category (Senior / Middle / Junior)">⚙ Manage team</button>` : ''}
      </div>
      ${legacyHoursNote()}
      <div class="res-add">
        <input id="e_resSearch" type="search" autocomplete="off" placeholder="Type an email to add a resource…" />
        <div id="e_resMatches" class="res-matches hidden"></div>
      </div>
      <div id="e_resRows" class="res-list"></div>
      <p class="muted small res-cap-note">Each resource has ${cap} hrs/month across all clients. The box caps at what's still free.</p>
    </div>

    <div class="entry-field">
      <label class="ef-label">Outsourcing / freelance costs — ${entry.mode === 'planned' ? 'planned / budget' : 'actual'}</label>
      <div id="e_outList"></div>
      <div class="out-add">
        <select id="e_outType">${(state.boot.jobTypes || ['Others']).map((j) => `<option value="${esc(j)}">${esc(j)}</option>`).join('')}</select>
        <input id="e_outCost" type="number" min="0" step="1" placeholder="Cost ₹" />
        <button type="button" id="e_outAdd" class="btn btn-sm">+ Add</button>
      </div>
    </div>

    ${acc && acc.wing === 'Content Creation' ? `
    <div class="entry-field">
      <label class="ef-label">Word count ${entry.mode === 'planned' ? 'planned' : 'delivered'}</label>
      <input id="e_wc" type="number" min="0" step="1" value="${entry.data[f.wc] || ''}" placeholder="e.g. 8000" />
    </div>` : ''}

    <div class="entry-field">
      <label class="ef-label">Notes (optional) — ${entry.mode === 'planned' ? 'planned' : 'actual'}</label>
      <input id="e_notes" value="${esc(entry.data[f.notes] || '')}" placeholder="Anything worth remembering…" />
    </div>

    <div class="entry-actions">
      <button id="e_save" class="btn btn-primary">${exists ? 'Update entry' : 'Save entry'}</button>
      <span id="e_saveMsg" class="muted"></span>
    </div>`;

  $('#entryBody').innerHTML = body;

  // wire revenue
  const revInp = $('#e_rev');
  const paintRevUsd = () => { $('#e_rev_usd').textContent = usd(Number(revInp.value) || 0); };
  revInp.oninput = () => { entry.data[f.rev] = Number(revInp.value) || 0; paintRevUsd(); renderPreview(); };
  paintRevUsd();

  // wire resources — an email search that adds rows, each with a live "free" label.
  renderResRows();
  wireResSearch();
  if (canManageTeam) $('#e_manageTeam').onclick = manageTeam;

  // outsourcing
  renderOutsourcing();
  $('#e_outAdd').onclick = () => {
    const cost = Number($('#e_outCost').value) || 0;
    if (!cost) return;
    const arr = entry.data[f.out] || (entry.data[f.out] = []);
    arr.push({ jobType: $('#e_outType').value, cost, vendor: '' });
    $('#e_outCost').value = '';
    renderOutsourcing(); renderPreview();
  };

  const wc = $('#e_wc'); if (wc) wc.oninput = () => { entry.data[f.wc] = Number(wc.value) || 0; };
  $('#e_notes').oninput = () => { entry.data[f.notes] = $('#e_notes').value; };
  $('#e_save').onclick = saveEntry;

  renderPreview();
}

// Legacy entries carry aggregate sr/jr hours with no per-person breakdown.
function legacyHoursNote() {
  const d = entry.data;
  const plan = entry.mode === 'planned';
  const sr = (plan ? d.srHrsPlan : d.srHrs) || 0;
  const mid = (plan ? d.midHrsPlan : d.midHrs) || 0;
  const jr = (plan ? d.jrHrsPlan : d.jrHrs) || 0;
  const hasBreakdown = (d[F().res] || []).length > 0;
  if (hasBreakdown || (!sr && !mid && !jr)) return '';
  const parts = [];
  if (sr) parts.push(`${sr} senior`);
  if (mid) parts.push(`${mid} middle`);
  if (jr) parts.push(`${jr} junior`);
  return `<div class="entry-flag" style="background:color-mix(in srgb,var(--amber) 12%,transparent);border-color:color-mix(in srgb,var(--amber) 34%,transparent);color:var(--amber)">
    Saved earlier as totals: ${parts.join(' + ')} hrs (no per-person split). These stay as-is unless you enter per-person hours below, which will replace them.</div>`;
}

function renderOutsourcing() {
  const list = $('#e_outList');
  const key = F().out;
  const arr = entry.data[key] || [];
  if (!arr.length) { list.innerHTML = '<p class="muted" style="margin:4px 0">None added.</p>'; return; }
  list.innerHTML = arr.map((o, i) => `
    <div class="out-row">
      <span>${esc(o.jobType)}</span>
      <span class="val">${inr(o.cost)}</span>
      <button type="button" class="btn btn-sm btn-danger out-del" data-i="${i}">✕</button>
    </div>`).join('');
  $$('.out-del').forEach((b) => (b.onclick = () => {
    (entry.data[key] || []).splice(Number(b.dataset.i), 1);
    renderOutsourcing(); renderPreview();
  }));
}

async function saveEntry() {
  const msg = $('#e_saveMsg');
  msg.textContent = 'Saving…';
  try {
    const f = F();
    // Mode-scoped payload: only touch the fields for the current Planned/Actual view.
    // Resource arrays are sent only when the user actually entered per-person hours,
    // so a legacy entry's aggregate hours are never silently wiped.
    const payload = {
      accountId: entry.accountId,
      month: entry.month,
      mode: entry.mode,
      [f.rev]: Number(entry.data[f.rev]) || 0,
      [f.out]: entry.data[f.out] || [],
      [f.notes]: entry.data[f.notes] || '',
    };
    if ((entry.data[f.res] || []).length) payload[f.res] = entry.data[f.res];
    const acc = state.boot.accounts.find((a) => a.id === entry.accountId);
    if (acc && acc.wing === 'Content Creation') payload[f.wc] = Number(entry.data[f.wc]) || 0;
    const r = await api('/entry', { method: 'PUT', body: JSON.stringify(payload) });
    entry.data = r.entry;
    if (r.capacity) entry.capacity = r.capacity;
    if (r.usageOther) entry.usageOther = r.usageOther;
    normalizeEntryData(entry.data);
    logSaveFeed();
    const c = r.computed;
    const stName = { healthy: '✅ Healthy', review: '⚠️ Review', atrisk: '🔴 At Risk', none: '—' }[c.status];
    renderPreview(c);
    msg.textContent = `Saved · GM ${pct(c.gm)} ${stName}`;
    toast('Entry saved');
    renderEntryBody();
    $('#e_saveMsg').textContent = `Saved · GM ${pct(c.gm)} ${stName}`;
  } catch (e) {
    msg.textContent = '';
    toast('Could not save: ' + e.message);
  }
}

// live local costing that mirrors the server GM engine (tool-share added on save)
function localCompute() {
  const a = state.boot.assumptions;
  const d = entry.data || {};
  const f = F();
  const revenue = Number(d[f.rev]) || 0;
  let manpower = 0;
  for (const r of (d[f.res] || [])) {
    const assoc = (state.boot.associates || []).find((x) => x.id === Number(r.id));
    if (!assoc) continue;
    manpower += (Number(r.hours) || 0) * rateFor(assoc);
  }
  const outsourcing = (d[f.out] || []).reduce((s, o) => s + (Number(o.cost) || 0), 0);
  const totalCost = manpower + outsourcing;
  const grossProfit = revenue - totalCost;
  const gm = revenue > 0 ? grossProfit / revenue : 0;
  let status = 'none';
  if (revenue > 0) status = gm >= a.gmHealthy ? 'healthy' : gm >= a.gmMin ? 'review' : 'atrisk';
  return { revenue, manpower, outsourcing, toolShare: 0, totalCost, grossProfit, gm, status, approx: true };
}

function renderPreview(computed) {
  if (!entry.data) { $('#preview').innerHTML = '<p class="muted">Start an entry — figures update as you fill.</p>'; return; }
  const c = computed || localCompute();
  const stName = { healthy: '✅ Healthy', review: '⚠️ Review', atrisk: '🔴 At Risk', none: 'No revenue yet' }[c.status];
  const row = (label, val) => `<div class="prow"><span>${label}</span><span class="val">${val}</span></div>`;
  $('#preview').innerHTML =
    row('Revenue', inrUsd(c.revenue)) +
    row('Manpower', '− ' + inr(c.manpower)) +
    row('Outsourcing', '− ' + inr(c.outsourcing)) +
    row('Tool share', '− ' + inr(c.toolShare) + (c.approx ? ' *' : '')) +
    `<div class="prow total"><span>Gross profit</span><span class="val">${inrUsd(c.grossProfit)}</span></div>` +
    `<div class="gm-badge st-${c.status}">GM ${pct(c.gm)} · ${stName}</div>` +
    (c.approx ? '<p class="muted" style="font-size:11px;margin-top:10px">* tool-share is apportioned across accounts when you save.</p>' : '');
}

// ---- team / resource manager (add / adjust senior vs junior) ----
function manageTeam() {
  const render = () => {
    const catOpts = (sel) => CATEGORIES.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
    const list = (state.boot.associates || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const rows = list.map((p) => `
      <div class="team-row" data-id="${p.id}">
        <input class="tm-name" type="email" value="${esc(p.name)}" placeholder="email@domain" />
        <select class="tm-cat">${catOpts(categoryOf(p))}</select>
        <button class="btn btn-sm tm-save">Save</button>
        <button class="btn btn-sm btn-danger tm-del">✕</button>
      </div>`).join('');
    const body = el('div');
    body.innerHTML = `
      <p class="muted">The team is loaded from <code>emp details.txt</code>, with categories from <code>emp categories.txt</code>. Each resource is identified by their <b>email</b>; its category (<b>Senior · Middle · Junior</b>) drives the ₹/hr rate used in costing.</p>
      <div id="teamList">${rows || '<p class="muted">No resources yet.</p>'}</div>
      <div class="team-add">
        <input id="tm_newName" type="email" placeholder="New person's email" />
        <select id="tm_newCat">${catOpts('Middle')}</select>
        <button id="tm_add" class="btn btn-sm btn-primary">+ Add</button>
      </div>`;
    openModalCustom('Manage team / resources', body);
    body.querySelectorAll('.team-row').forEach((rowEl) => {
      const id = Number(rowEl.dataset.id);
      rowEl.querySelector('.tm-save').onclick = async () => {
        await api('/associates/' + id, { method: 'PUT', body: JSON.stringify({ name: rowEl.querySelector('.tm-name').value, category: rowEl.querySelector('.tm-cat').value }) });
        state.boot.associates = await api('/associates'); toast('Saved'); render();
      };
      rowEl.querySelector('.tm-del').onclick = async () => {
        if (!confirm('Remove this person?')) return;
        await api('/associates/' + id, { method: 'DELETE' });
        state.boot.associates = await api('/associates'); toast('Removed'); render();
      };
    });
    body.querySelector('#tm_add').onclick = async () => {
      const name = body.querySelector('#tm_newName').value.trim();
      if (!name) { toast('Name required'); return; }
      await api('/associates', { method: 'POST', body: JSON.stringify({ name, category: body.querySelector('#tm_newCat').value }) });
      state.boot.associates = await api('/associates'); toast('Added'); render();
    };
  };
  render();
}

// ================= DASHBOARD / REPORTS =================
$('#dashRefresh').addEventListener('click', loadDashboard);
$('#dashMode').addEventListener('change', loadDashboard);

async function loadDashboard() {
  const mode = $('#dashMode').value;
  const d = await api('/dashboard?mode=' + mode);
  state.dash = d;
  renderKpis(d.ytd);                       // YTD portfolio KPIs up top
  renderMonthly(d.monthly);
  setupPlanActual(d.comparison, d.comparisonYtd); // Plan vs Actual w/ built-in month select
  setupClientCompare(d.comparisonByClient); // Plan vs Actual per customer
  setupResources(d.resourceByClient, d.resourceByPerson); // Resources plan vs actual + Asana
  renderToolsReport();                     // Tools budget vs actual spend
  renderWings(d.wingSummary);
  setupRanking(d.ranking);
  wireReportFilter();                      // show one report at a time
}

// ---- report picker (user, 2026-08-26) ----
// Reports were one long scroll; now a pill bar at the top shows a single report at a
// time. Everything is still rendered on load — the filter just toggles visibility.
function applyReport(name) {
  state.reportTab = name;
  $$('#reportFilter .rf-pill').forEach((b) => b.classList.toggle('active', b.dataset.report === name));
  $$('#view-dashboard .report-block').forEach((b) => { b.hidden = b.dataset.report !== name; });
}
function wireReportFilter() {
  $$('#reportFilter .rf-pill').forEach((b) => (b.onclick = () => applyReport(b.dataset.report)));
  applyReport(state.reportTab || 'overview');
}

// ---- drill-down details (user, 2026-09-01) ----
// The whole report row is clickable: clicking anywhere on it opens a full breakdown
// for that month / client in a new browser tab (replaced the old per-cell 🔍 button).
function openDetailTab(type, key) {
  const url = `?view=detail&type=${encodeURIComponent(type)}&key=${encodeURIComponent(key)}`;
  window.open(url, '_blank', 'noopener');
}
// Attributes that turn a <tr> into a clickable link to the drill-down detail tab.
function rowLink(type, key, extraClass) {
  return `class="row-link${extraClass ? ' ' + extraClass : ''}" data-dtype="${esc(type)}" data-dkey="${esc(String(key))}" title="Click for full details"`;
}
function wireRowLinks(root) {
  $$('tr.row-link', root || document).forEach((tr) => (tr.onclick = () => openDetailTab(tr.dataset.dtype, tr.dataset.dkey)));
}

// Costs are expenses, so reports show them as negative red figures (user, 2026-08-17).
const costSpan = (n) => `<span style="color:var(--red)">${(Number(n) || 0) ? '−' : ''}${inr(n)}</span>`;
const costCell = (n) => `<td>${costSpan(n)}</td>`;

function varCell(v, asPct) {
  const cls = v >= 0 ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
  const sign = v > 0 ? '+' : '';
  const txt = asPct ? sign + (v * 100).toFixed(1) + '%' : sign + inr(v).replace('₹', '₹');
  return `<td ${cls}>${txt}</td>`;
}
// Cost / hours variance = actual − plan, where spending (or booking) LESS than planned
// is the good outcome, so the colours are the mirror of revenue variance.
function varCostCell(v) {
  const cls = v <= 0 ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
  const sign = v > 0 ? '+' : (v < 0 ? '−' : '');
  return `<td ${cls}>${sign}${inr(Math.abs(v))}</td>`;
}
function varHrsCell(v) {
  const cls = v <= 0 ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
  const sign = v > 0 ? '+' : (v < 0 ? '−' : '');
  return `<td ${cls}>${sign}${hrsFmt(Math.abs(v))}</td>`;
}
const hrsFmt = (n) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('en-IN') + ' hr';

// ---- Plan vs Actual with a built-in month selector (user, 2026-08-21) ----
// Tick any months to total just those; none ticked = the full year. The KPI strip,
// the scope caption and the table's total row all recompute from the selection.
function sumComparison(rows) {
  const s = (f) => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const planRevenue = s('planRevenue'), actualRevenue = s('actualRevenue');
  const planCost = s('planCost'), actualCost = s('actualCost');
  const planGP = s('planGP'), actualGP = s('actualGP');
  const planGM = planRevenue > 0 ? planGP / planRevenue : 0;
  const actualGM = actualRevenue > 0 ? actualGP / actualRevenue : 0;
  return {
    planRevenue, actualRevenue, planCost, actualCost, planGP, actualGP, planGM, actualGM,
    revVariance: actualRevenue - planRevenue,
    gpVariance: actualGP - planGP,
    gmVariance: actualGM - planGM,
  };
}

function setupPlanActual(rows, ytd) {
  state.cmpRows = rows || [];
  state.cmpYtd = ytd;
  const pick = $('#cmpMonthsPick');
  if (pick) {
    const prev = new Set(state.cmpMonths || []);
    pick.innerHTML = state.cmpRows.map((r) => {
      const has = r.planRevenue || r.actualRevenue;
      return `<label class="mp-chip ${has ? '' : 'mp-empty'}"><input type="checkbox" value="${r.month}" ${prev.has(r.month) ? 'checked' : ''}/> ${r.month}</label>`;
    }).join('');
    $$('#cmpMonthsPick input[type=checkbox]').forEach((cb) => (cb.onchange = () => {
      state.cmpMonths = $$('#cmpMonthsPick input:checked').map((c) => c.value);
      renderPlanActual();
    }));
    const clear = $('#cmpMonthsClear');
    if (clear) clear.onclick = () => { state.cmpMonths = []; setupPlanActual(state.cmpRows, state.cmpYtd); };
  }
  renderPlanActual();
}

function renderPlanActual() {
  const rows = state.cmpRows || [];
  const sel = state.cmpMonths || [];
  const chosen = sel.length ? rows.filter((r) => sel.includes(r.month)) : rows;
  const tot = sumComparison(chosen);

  const scopeEl = $('#cmpScope');
  if (scopeEl) scopeEl.textContent = sel.length
    ? `Totals for ${sel.length} selected month${sel.length > 1 ? 's' : ''}: ${sel.join(', ')}`
    : 'Totals for the full year (all months) — tick months above to narrow the calculation.';

  // KPI strip (reflects the current selection)
  const k = (label, plan, actual, vr, asPct) => {
    const cls = vr >= 0 ? 'up' : 'down';
    const vtxt = asPct ? (vr > 0 ? '+' : '') + (vr * 100).toFixed(1) + '%' : (vr > 0 ? '+' : '') + inr(vr);
    return `<div class="cmp-kpi">
      <div class="label">${label}</div>
      <div class="cmp-two"><span class="plan">Plan ${asPct ? pct(plan) : inr(plan)}</span><span class="act">Actual ${asPct ? pct(actual) : inr(actual)}</span></div>
      <div class="cmp-var ${cls}">${vtxt}</div>
    </div>`;
  };
  const kpiEl = $('#cmpKpis');
  if (kpiEl) kpiEl.innerHTML =
    k('Revenue', tot.planRevenue, tot.actualRevenue, tot.revVariance, false) +
    k('Gross profit', tot.planGP, tot.actualGP, tot.gpVariance, false) +
    k('Gross margin', tot.planGM, tot.actualGM, tot.gmVariance, true) +
    k('Cost', tot.planCost, tot.actualCost, tot.actualCost - tot.planCost, false);

  // table — every month row, selected ones highlighted, plus a scope total row
  const head = ['Month', 'Plan Rev', 'Actual Rev', 'Δ Rev', 'Plan GP', 'Actual GP', 'Δ GP', 'Plan GM', 'Actual GM', 'Δ GM'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  const active = rows.filter((r) => r.planRevenue || r.actualRevenue);
  if (!active.length) html += `<tr><td colspan="10" class="l muted">No entries yet.</td></tr>`;
  active.forEach((r) => {
    const on = sel.includes(r.month);
    html += `<tr ${rowLink('month', r.month, on ? 'row-sel' : '')}><td class="l">${r.month}</td>` +
      `<td>${inr(r.planRevenue)}</td><td>${inr(r.actualRevenue)}</td>${varCell(r.revVariance)}` +
      `<td>${inr(r.planGP)}</td><td>${inr(r.actualGP)}</td>${varCell(r.gpVariance)}` +
      `<td>${pct(r.planGM)}</td><td>${pct(r.actualGM)}</td>${varCell(r.gmVariance, true)}</tr>`;
  });
  if (active.length) {
    const label = sel.length ? `Selected (${sel.length})` : 'Full year';
    html += `<tr class="row-total"><td class="l"><b>${label}</b></td>` +
      `<td>${inr(tot.planRevenue)}</td><td>${inr(tot.actualRevenue)}</td>${varCell(tot.revVariance)}` +
      `<td>${inr(tot.planGP)}</td><td>${inr(tot.actualGP)}</td>${varCell(tot.gpVariance)}` +
      `<td>${pct(tot.planGM)}</td><td>${pct(tot.actualGM)}</td>${varCell(tot.gmVariance, true)}</tr>`;
  }
  $('#cmpTable').innerHTML = html + '</tbody>';
  wireRowLinks($('#cmpTable'));
}

// ---- Plan vs Actual per customer (user, 2026-08-24) ----
// One row per client (summed across its departments + months), showing planned vs
// actual revenue, cost, gross profit and margin with the variance. Filterable by name.
function setupClientCompare(rows) {
  state.clientCmp = rows || [];
  const search = $('#clientCmpSearch');
  if (search) search.oninput = renderClientCompare;
  renderClientCompare();
}

function renderClientCompare() {
  const q = (($('#clientCmpSearch') && $('#clientCmpSearch').value) || '').trim().toLowerCase();
  const rows = (state.clientCmp || []).filter((r) => !q || String(r.name || '').toLowerCase().includes(q));
  const head = ['Client', 'Plan Rev', 'Actual Rev', 'Δ Rev', 'Plan Cost', 'Actual Cost', 'Plan GP', 'Actual GP', 'Δ GP', 'Plan GM', 'Actual GM', 'Δ GM'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  if (!rows.length) html += `<tr><td colspan="12" class="l muted">${(state.clientCmp || []).length ? 'No clients match the filter.' : 'No entries yet.'}</td></tr>`;
  const t = { planRevenue: 0, actualRevenue: 0, planCost: 0, actualCost: 0, planGP: 0, actualGP: 0 };
  rows.forEach((r) => {
    Object.keys(t).forEach((k) => (t[k] += Number(r[k]) || 0));
    html += `<tr ${rowLink('client', r.name)}><td class="l">${esc(r.name)}</td>` +
      `<td>${inr(r.planRevenue)}</td><td>${inr(r.actualRevenue)}</td>${varCell(r.revVariance)}` +
      `${costCell(r.planCost)}${costCell(r.actualCost)}` +
      `<td>${inr(r.planGP)}</td><td>${inr(r.actualGP)}</td>${varCell(r.gpVariance)}` +
      `<td>${pct(r.planGM)}</td><td>${pct(r.actualGM)}</td>${varCell(r.gmVariance, true)}</tr>`;
  });
  if (rows.length) {
    const pGM = t.planRevenue ? t.planGP / t.planRevenue : 0;
    const aGM = t.actualRevenue ? t.actualGP / t.actualRevenue : 0;
    html += `<tr class="row-total"><td class="l"><b>Total</b></td>` +
      `<td>${inr(t.planRevenue)}</td><td>${inr(t.actualRevenue)}</td>${varCell(t.actualRevenue - t.planRevenue)}` +
      `${costCell(t.planCost)}${costCell(t.actualCost)}` +
      `<td>${inr(t.planGP)}</td><td>${inr(t.actualGP)}</td>${varCell(t.actualGP - t.planGP)}` +
      `<td>${pct(pGM)}</td><td>${pct(aGM)}</td>${varCell(aGM - pGM, true)}</tr>`;
  }
  $('#clientCmpTable').innerHTML = html + '</tbody>';
  wireRowLinks($('#clientCmpTable'));
}

// ---- Resources: planned vs actual hours (user, 2026-08-26) ----
// Two scopes: "By client" (booked hours + ₹ cost per client) and "By resource"
// (each person's planned vs actual load, with a link to their Asana assignments).
function setupResources(byClient, byPerson) {
  state.resByClient = byClient || [];
  state.resByPerson = byPerson || [];
  state.resScope = state.resScope || 'client';
  const seg = $('#resScope');
  if (seg) {
    $$('button', seg).forEach((b) => {
      b.classList.toggle('active', b.dataset.scope === state.resScope);
      b.onclick = () => {
        state.resScope = b.dataset.scope;
        $$('button', seg).forEach((x) => x.classList.toggle('active', x === b));
        renderResources();
      };
    });
  }
  const search = $('#resSearch');
  if (search) search.oninput = renderResources;
  renderResources();
}

function renderResources() {
  const table = $('#resourceTable');
  if (!table) return;
  const scope = state.resScope || 'client';
  const q = (($('#resSearch') && $('#resSearch').value) || '').trim().toLowerCase();

  if (scope === 'client') {
    const rows = (state.resByClient || []).filter((r) => !q || String(r.name || '').toLowerCase().includes(q));
    const head = ['Client', 'Plan hrs', 'Actual hrs', 'Δ hrs', 'Plan cost', 'Actual cost', 'Δ cost'];
    let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l sticky-col' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
    if (!rows.length) html += `<tr><td colspan="7" class="l muted">${(state.resByClient || []).length ? 'No clients match the filter.' : 'No resource hours logged yet.'}</td></tr>`;
    let ph = 0, ah = 0, pc = 0, ac = 0;
    rows.forEach((r) => {
      ph += r.planHours; ah += r.actualHours; pc += r.planCost; ac += r.actualCost;
      html += `<tr ${rowLink('client', r.name)}><td class="l sticky-col">${esc(r.name)}</td>` +
        `<td>${hrsFmt(r.planHours)}</td><td>${hrsFmt(r.actualHours)}</td>${varHrsCell(r.hoursVariance)}` +
        `<td>${inr(r.planCost)}</td><td>${inr(r.actualCost)}</td>${varCostCell(r.costVariance)}</tr>`;
    });
    if (rows.length) {
      html += `<tr class="row-total"><td class="l sticky-col"><b>Total</b></td>` +
        `<td>${hrsFmt(ph)}</td><td>${hrsFmt(ah)}</td>${varHrsCell(ah - ph)}` +
        `<td>${inr(pc)}</td><td>${inr(ac)}</td>${varCostCell(ac - pc)}</tr>`;
    }
    table.innerHTML = html + '</tbody>';
    wireRowLinks(table);
  } else {
    const rows = (state.resByPerson || []).filter((r) => !q || String(r.name || '').toLowerCase().includes(q));
    const showCat = isSuper();
    // % utilisation = actual booked hours ÷ each person's total capacity for the year
    // (hours/month × number of months), from the server (user, 2026-09-01).
    const head = ['Resource'].concat(showCat ? ['Category'] : []).concat(['Plan hrs', 'Actual hrs', 'Δ hrs', 'Utilisation', 'Asana']);
    const cols = head.length;
    let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l sticky-col' : (i === 1 && showCat ? 'l' : '')}">${h}</th>`).join('') + '</tr></thead><tbody>';
    if (!rows.length) html += `<tr><td colspan="${cols}" class="l muted">${(state.resByPerson || []).length ? 'No resources match the filter.' : 'No resource hours logged yet.'}</td></tr>`;
    let ph = 0, ah = 0, cap = 0;
    rows.forEach((r) => {
      ph += r.planHours; ah += r.actualHours; cap += (Number(r.capacity) || 0);
      const catCell = showCat
        ? `<td class="l">${r.category ? `<span class="cat-tag cat-${String(r.category).toLowerCase()}">${esc(r.category)}</span>` : ''}</td>`
        : '';
      html += `<tr><td class="l sticky-col">${esc(r.name)}</td>${catCell}` +
        `<td>${hrsFmt(r.planHours)}</td><td>${hrsFmt(r.actualHours)}</td>${varHrsCell(r.hoursVariance)}` +
        `<td>${utilCell(r.utilisation)}</td>` +
        `<td><button type="button" class="btn btn-sm btn-ghost res-asana-rep" data-email="${esc(r.name)}" title="Open Asana assignments for ${esc(r.name)}">📋 Asana</button></td></tr>`;
    });
    if (rows.length) {
      const catTot = showCat ? '<td class="l"></td>' : '';
      html += `<tr class="row-total"><td class="l sticky-col"><b>Total</b></td>${catTot}` +
        `<td>${hrsFmt(ph)}</td><td>${hrsFmt(ah)}</td>${varHrsCell(ah - ph)}` +
        `<td>${utilCell(cap ? ah / cap : 0)}</td><td></td></tr>`;
    }
    table.innerHTML = html + '</tbody>';
    $$('.res-asana-rep', table).forEach((b) => (b.onclick = () => window.open(asanaUrl(b.dataset.email), '_blank', 'noopener')));
  }
}

// Utilisation cell: green when comfortably loaded, amber when light, red when > 100%
// (over-booked vs the monthly hour cap).
function utilCell(u) {
  const p = (Number(u) || 0) * 100;
  const col = p > 100 ? 'var(--red)' : p >= 60 ? 'var(--green)' : 'var(--muted)';
  return `<span style="color:${col};font-weight:600">${p.toFixed(0)}%</span>`;
}

// ---- Tools: budget vs actual monthly spend, per department (user, 2026-08-26) ----
// Built client-side from the tools list + per-department budgets already in bootstrap.
function renderToolsReport() {
  const table = $('#toolReportTable');
  if (!table) return;
  const tools = state.boot.tools || [];
  const budgets = (state.boot && state.boot.toolBudgets) || {};
  const byDept = {};
  tools.filter((t) => t.active !== false).forEach((t) => {
    if (t.common && t.deptCosts && Object.keys(t.deptCosts).length) {
      for (const [d, amt] of Object.entries(t.deptCosts)) byDept[d] = (byDept[d] || 0) + amtInr(amt, t.currency);
    } else {
      const d = t.department || 'General';
      byDept[d] = (byDept[d] || 0) + toolMonthlyInr(t);
    }
  });
  const names = [...new Set([...Object.keys(byDept), ...Object.keys(budgets)])].sort();
  const head = ['Department', 'Monthly budget', 'Actual / mo', 'Δ (budget − actual)', 'Annual budget', 'Annual actual'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l sticky-col' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  if (!names.length) html += `<tr><td colspan="6" class="l muted">No tools or budgets yet.</td></tr>`;
  let tb = 0, ta = 0;
  names.forEach((d) => {
    const budget = Number(budgets[d]) || 0; const actual = byDept[d] || 0; tb += budget; ta += actual;
    const diff = budget - actual; const over = budget > 0 && actual > budget;
    const diffCls = diff >= 0 ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
    html += `<tr><td class="l sticky-col">${esc(d)}</td>` +
      `<td>${budget ? inr(budget) : '—'}</td><td>${inr(actual)}</td>` +
      `<td ${diffCls}>${budget ? ((diff < 0 ? '−' : '') + inr(Math.abs(diff)) + (over ? ' ⚠' : '')) : '—'}</td>` +
      `<td>${budget ? inr(budget * 12) : '—'}</td><td>${inr(actual * 12)}</td></tr>`;
  });
  if (names.length) {
    const td = tb - ta;
    html += `<tr class="row-total"><td class="l sticky-col"><b>Total</b></td>` +
      `<td>${tb ? inr(tb) : '—'}</td><td>${inr(ta)}</td>` +
      `<td style="color:var(--${td >= 0 ? 'green' : 'red'})">${tb ? ((td < 0 ? '−' : '') + inr(Math.abs(td))) : '—'}</td>` +
      `<td>${tb ? inr(tb * 12) : '—'}</td><td>${inr(ta * 12)}</td></tr>`;
  }
  table.innerHTML = html + '</tbody>';
}

function renderKpis(y) {
  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('#dashKpis').innerHTML =
    kpi('YTD Revenue', inr(y.revenue), '≈ ' + usd(y.revenue)) +
    kpi('YTD Cost', costSpan(y.totalCost), '≈ −' + usd(y.totalCost)) +
    kpi('Gross Profit', inr(y.grossProfit), '≈ ' + usd(y.grossProfit)) +
    kpi('Gross Margin', pct(y.gm)) +
    kpi('Active accounts', y.activeAccounts) +
    kpi('✅ / ⚠️ / 🔴', `${y.healthy} / ${y.review} / ${y.atrisk}`);
}
function statusPill(s) {
  const name = { healthy: '✅ Healthy', review: '⚠️ Review', atrisk: '🔴 At Risk', none: '—' }[s] || '—';
  return `<span class="pill ${s}">${name}</span>`;
}
function renderMonthly(rows) {
  const head = ['Month', 'Revenue', 'Manpower', 'Outsource', 'Tool', 'Total Cost', 'Gross Profit', 'GM %', 'Active', '✅', '⚠️', '🔴'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  const t = { revenue: 0, manpower: 0, outsourcing: 0, toolShare: 0, totalCost: 0, grossProfit: 0 };
  rows.forEach((r) => {
    Object.keys(t).forEach((k) => (t[k] += Number(r[k]) || 0));
    html += `<tr ${rowLink('month', r.month)}><td class="l">${r.month}</td><td>${inrUsd(r.revenue)}</td>${costCell(r.manpower)}${costCell(r.outsourcing)}${costCell(r.toolShare)}${costCell(r.totalCost)}<td>${inrUsd(r.grossProfit)}</td><td>${pct(r.gm)}</td><td>${r.activeAccounts}</td><td>${r.healthy}</td><td>${r.review}</td><td>${r.atrisk}</td></tr>`;
  });
  if (rows.length) {
    const tgm = t.revenue ? t.grossProfit / t.revenue : 0;
    html += `<tr class="row-total"><td class="l"><b>Total</b></td><td>${inrUsd(t.revenue)}</td>${costCell(t.manpower)}${costCell(t.outsourcing)}${costCell(t.toolShare)}${costCell(t.totalCost)}<td>${inrUsd(t.grossProfit)}</td><td>${pct(tgm)}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
  }
  $('#monthlyTable').innerHTML = html + '</tbody>';
  wireRowLinks($('#monthlyTable'));
}

function renderWings(rows) {
  const head = ['Service / Dept', 'Revenue', 'Total Cost', 'Gross Profit', 'GM %', 'Status'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  const t = { revenue: 0, totalCost: 0, grossProfit: 0 };
  rows.forEach((r) => {
    Object.keys(t).forEach((k) => (t[k] += Number(r[k]) || 0));
    html += `<tr><td class="l">${r.wing}</td><td>${inrUsd(r.revenue)}</td>${costCell(r.totalCost)}<td>${inrUsd(r.grossProfit)}</td><td>${pct(r.gm)}</td><td>${statusPill(r.status)}</td></tr>`;
  });
  if (rows.length) {
    const tgm = t.revenue ? t.grossProfit / t.revenue : 0;
    html += `<tr class="row-total"><td class="l"><b>Total</b></td><td>${inrUsd(t.revenue)}</td>${costCell(t.totalCost)}<td>${inrUsd(t.grossProfit)}</td><td>${pct(tgm)}</td><td></td></tr>`;
  }
  $('#wingTable').innerHTML = html + '</tbody>';
}
// Ranking (the last "top revenue" report) with a department + name filter.
function setupRanking(rows) {
  state.rankRows = rows || [];
  const sel = $('#rankWingFilter');
  if (sel) {
    const wings = [...new Set(state.rankRows.map((r) => r.wing).filter(Boolean))].sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">All departments</option>' +
      wings.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('');
    if (wings.includes(cur)) sel.value = cur;
    sel.onchange = renderRanking;
  }
  const search = $('#rankSearch');
  if (search) search.oninput = renderRanking;
  renderRanking();
}

function renderRanking() {
  const wing = ($('#rankWingFilter') && $('#rankWingFilter').value) || '';
  const q = (($('#rankSearch') && $('#rankSearch').value) || '').trim().toLowerCase();
  const rows = (state.rankRows || []).filter((r) =>
    (!wing || r.wing === wing) && (!q || String(r.name || '').toLowerCase().includes(q)));

  const head = ['#', 'Account', 'Service', 'Revenue', 'Total Cost', 'Gross Profit', 'GM %', 'Target', 'Variance', 'Status'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 1 || i === 2 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  if (!rows.length) html += `<tr><td colspan="10" class="l muted">${(state.rankRows || []).length ? 'No accounts match the filter.' : 'No entries yet — use the Update tab.'}</td></tr>`;
  const t = { revenue: 0, totalCost: 0, grossProfit: 0 };
  rows.forEach((r, i) => {
    Object.keys(t).forEach((k) => (t[k] += Number(r[k]) || 0));
    const vClass = r.variance >= 0 ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
    html += `<tr ${rowLink('client', r.name)}><td class="l">${i + 1}</td><td class="l">${esc(r.name)}</td><td class="l">${esc(r.wing) || '—'}</td><td>${inrUsd(r.revenue)}</td>${costCell(r.totalCost)}<td>${inrUsd(r.grossProfit)}</td><td>${pct(r.gm)}</td><td>${pct(r.budgetGM)}</td><td ${vClass}>${(r.variance * 100).toFixed(1)}%</td><td>${statusPill(r.status)}</td></tr>`;
  });
  if (rows.length) {
    const tgm = t.revenue ? t.grossProfit / t.revenue : 0;
    html += `<tr class="row-total"><td class="l"></td><td class="l"><b>Total</b></td><td class="l"></td><td>${inrUsd(t.revenue)}</td>${costCell(t.totalCost)}<td>${inrUsd(t.grossProfit)}</td><td>${pct(tgm)}</td><td>—</td><td>—</td><td></td></tr>`;
  }
  $('#rankTable').innerHTML = html + '</tbody>';
  wireRowLinks($('#rankTable'));
}

// ================= DRILL-DOWN DETAIL VIEW (opens in its own tab) =================
// Reached only via ?view=detail&type=…&key=… (the 🔍 buttons in Reports). Shows every
// entry behind a month or a client — Plan and Actual side by side, with the resources,
// outsourcing and notes that make up each figure (user, 2026-08-24).
function maybeOpenDetail() {
  const p = new URLSearchParams(location.search);
  if (p.get('view') !== 'detail') return false;
  const type = p.get('type') === 'client' ? 'client' : 'month';
  const key = p.get('key') || '';
  switchView('detail');
  loadDetail(type, key);
  return true;
}

async function loadDetail(type, key) {
  const host = $('#detailBody');
  $('#detailTitle').textContent = (type === 'client' ? 'Client · ' : 'Month · ') + key;
  document.title = `${type === 'client' ? 'Client' : 'Month'} · ${key} — BNGM`;
  host.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api(`/detail?type=${encodeURIComponent(type)}&key=${encodeURIComponent(key)}`);
    renderDetail(d);
  } catch (e) { host.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function renderDetail(d) {
  const host = $('#detailBody');
  const p = d.planTotals || {}, a = d.actualTotals || {};
  const k = (label, plan, actual, asPct, cost) => {
    const vr = (Number(actual) || 0) - (Number(plan) || 0);
    const cls = (cost ? -vr : vr) >= 0 ? 'up' : 'down';
    const fmt = (v) => asPct ? pct(v) : inr(v);
    const vtxt = asPct ? (vr > 0 ? '+' : '') + (vr * 100).toFixed(1) + '%' : (vr > 0 ? '+' : '') + inr(vr);
    return `<div class="cmp-kpi">
      <div class="label">${label}</div>
      <div class="cmp-two"><span class="plan">Plan ${fmt(plan)}</span><span class="act">Actual ${fmt(actual)}</span></div>
      <div class="cmp-var ${cls}">${vtxt}</div>
    </div>`;
  };
  const totals = `<div class="cmp-row">
    ${k('Revenue', p.revenue, a.revenue, false)}
    ${k('Total cost', p.totalCost, a.totalCost, false, true)}
    ${k('Gross profit', p.grossProfit, a.grossProfit, false)}
    ${k('Gross margin', p.gm, a.gm, true)}
  </div>`;

  if (!d.items || !d.items.length) {
    host.innerHTML = totals + '<p class="muted" style="margin-top:16px">No entries recorded here yet.</p>';
    return;
  }

  // Row/column table (user, 2026-08-26): one row per entry with the first column
  // (month or client) pinned. Each row expands (▸) to show the resources, outsourcing
  // and notes behind it, Plan vs Actual.
  const firstLabel = d.type === 'client' ? 'Month · Dept' : 'Client · Dept';
  const head = [firstLabel, 'Plan Rev', 'Act Rev', 'Plan Cost', 'Act Cost', 'Plan GP', 'Act GP', 'Plan GM', 'Act GM'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l sticky-col' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  d.items.forEach((it, idx) => {
    const first = d.type === 'client' ? `${esc(it.month)} · ${esc(it.wing || '—')}` : `${esc(it.name)} · ${esc(it.wing || '—')}`;
    const pp = it.plan || {}, aa = it.actual || {};
    html += `<tr class="d-main"><td class="l sticky-col"><button type="button" class="d-exp" data-idx="${idx}" title="Show resources, outsourcing & notes">▸</button> ${first}</td>` +
      `<td>${inr(pp.revenue)}</td><td>${inr(aa.revenue)}</td>` +
      `${costCell(pp.totalCost)}${costCell(aa.totalCost)}` +
      `<td>${inr(pp.grossProfit)}</td><td>${inr(aa.grossProfit)}</td>` +
      `<td>${pct(pp.gm)}</td><td>${pct(aa.gm)}</td></tr>`;
    html += `<tr class="d-sub hidden" data-sub="${idx}"><td colspan="9" class="l">${detailSub(it)}</td></tr>`;
  });
  html += `<tr class="row-total"><td class="l sticky-col"><b>Total</b></td>` +
    `<td>${inr(p.revenue)}</td><td>${inr(a.revenue)}</td>` +
    `${costCell(p.totalCost)}${costCell(a.totalCost)}` +
    `<td>${inr(p.grossProfit)}</td><td>${inr(a.grossProfit)}</td>` +
    `<td>${pct(p.gm)}</td><td>${pct(a.gm)}</td></tr>`;

  host.innerHTML = totals + `<div class="table-scroll glass" style="margin-top:16px"><table class="data detail-table">${html}</tbody></table></div>`;
  $$('.d-exp', host).forEach((b) => (b.onclick = () => {
    const sub = host.querySelector(`tr[data-sub="${b.dataset.idx}"]`);
    if (!sub) return;
    const open = sub.classList.toggle('hidden') === false;
    b.textContent = open ? '▾' : '▸';
  }));
}

// The plan-vs-actual breakdown (resources / outsourcing / notes) shown under an
// expanded detail row.
function detailSub(it) {
  const resList = (arr) => (arr && arr.length)
    ? arr.map((r) => `<div class="pr-line"><span>${esc(r.name)}${(isSuper() && r.category) ? ` <span class="cat-tag cat-${String(r.category).toLowerCase()}">${esc(r.category)}</span>` : ''}</span><span class="val">${r.hours} hr</span></div>`).join('')
    : '<div class="muted small">None</div>';
  const outList = (arr) => (arr && arr.length)
    ? arr.map((o) => `<div class="pr-line"><span>${esc(o.jobType || 'Others')}</span><span class="val">${inr(o.cost)}</span></div>`).join('')
    : '<div class="muted small">None</div>';
  const notes = (t) => t ? `<div class="d-notes">${esc(t)}</div>` : '<div class="muted small">—</div>';
  return `<div class="dc-cols">
    <div class="dc-col">
      <div class="pr-sub">Planned resources</div>${resList(it.resourcesPlan)}
      <div class="pr-sub">Planned outsourcing</div>${outList(it.outsourcingPlan)}
      <div class="pr-sub">Planned notes</div>${notes(it.notesPlan)}
    </div>
    <div class="dc-col">
      <div class="pr-sub">Actual resources</div>${resList(it.resourcesActual)}
      <div class="pr-sub">Actual outsourcing</div>${outList(it.outsourcingActual)}
      <div class="pr-sub">Actual notes</div>${notes(it.notesActual)}
    </div>
  </div>`;
}

// ================= TOOLS (table + cumulative panel) =================
$('#addToolBtn').addEventListener('click', () => editTool(null));

function amtInr(amount, currency) {
  const c = Number(amount) || 0;
  return currency === 'INR' ? c : c * fxRate();
}
function toolMonthlyInr(t) {
  return amtInr(t.cost, t.currency);
}
// Human-readable per-department split for a common tool (used as a tooltip).
function commonSplitLabel(t) {
  const dc = (t && t.deptCosts) || {};
  const parts = Object.entries(dc).map(([d, amt]) => `${d}: ${inr(amtInr(amt, t.currency))}`);
  return parts.length ? 'Split — ' + parts.join(', ') : 'Common (no split set)';
}
function monthsElapsed(startDate, endDate) {
  if (!startDate) return 0;
  const s = new Date(startDate + 'T00:00:00');
  const e = endDate ? new Date(endDate + 'T00:00:00') : new Date();
  if (isNaN(s) || e < s) return 0;
  let m = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() >= s.getDate()) m += 1; // count the current partial month
  return Math.max(0, m);
}
function toolSpentToDate(t) {
  const end = t.active === false ? t.stopDate : '';
  return toolMonthlyInr(t) * monthsElapsed(t.startDate, end);
}

function renderTools() {
  const tools = state.boot.tools || [];
  const canEdit = state.roleInfo.canManageTools;
  const tbody = $('#toolsTable');
  if (!tools.length) {
    tbody.innerHTML = `<tbody><tr><td colspan="7" class="l muted">No tools yet.${canEdit ? ' Use “+ New tool”.' : ''}</td></tr></tbody>`;
    $('#toolsCumulative').innerHTML = '';
    return;
  }
  const head = ['Tool', 'Dept', 'Cost / mo', 'Started', 'Status', 'Spent to date', canEdit ? '' : ''];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i < 2 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  tools.forEach((t) => {
    const cost = Number(t.cost) || 0;
    const costTxt = !cost ? 'Free'
      : t.currency === 'INR' ? `${inrUsd(cost)}` : `<span class="inr-cell" title="≈ ${inr(cost * fxRate())}">$${cost.toLocaleString('en-US')}<span class="usd">≈ ${inr(cost * fxRate())}</span></span>`;
    const stopped = t.active === false;
    const statusTxt = stopped ? `<span class="pill atrisk">■ Stopped</span>` : `<span class="pill healthy">▶ Active</span>`;
    html += `<tr class="${stopped ? 'tool-stopped' : ''}">
      <td class="l"><b>${esc(t.name)}</b>${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}${t.why ? `<div class="why-inline">Why: ${esc(t.why)}</div>` : ''}</td>
      <td class="l">${t.common ? `<span class="tag-common" title="${esc(commonSplitLabel(t))}">Common</span>` : esc(t.department || 'General')}</td>
      <td>${costTxt}<span class="per">/mo</span></td>
      <td>${t.startDate || '—'}${stopped && t.stopDate ? `<div class="muted small">stopped ${t.stopDate}</div>` : ''}</td>
      <td>${statusTxt}</td>
      <td>${inr(toolSpentToDate(t))}</td>
      ${canEdit ? `<td class="tool-actions-cell">
        <button class="btn btn-sm tool-stop" data-id="${t.id}">${stopped ? 'Resume' : 'Stop'}</button>
        <button class="btn btn-sm edit-tool" data-id="${t.id}">Edit</button>
        <button class="btn btn-sm btn-danger del-tool" data-id="${t.id}">Del</button>
      </td>` : '<td></td>'}
    </tr>`;
  });
  tbody.innerHTML = html + '</tbody>';
  $$('.edit-tool').forEach((b) => (b.onclick = () => editTool(Number(b.dataset.id))));
  $$('.del-tool').forEach((b) => (b.onclick = () => deleteTool(Number(b.dataset.id))));
  $$('.tool-stop').forEach((b) => (b.onclick = () => toggleToolActive(Number(b.dataset.id))));

  renderToolsCumulative(tools);
}

function renderToolsCumulative(tools) {
  const activeTools = tools.filter((t) => t.active !== false);
  const stoppedTools = tools.filter((t) => t.active === false);
  const monthlyActive = activeTools.reduce((s, t) => s + toolMonthlyInr(t), 0);
  const spentAll = tools.reduce((s, t) => s + toolSpentToDate(t), 0);
  const dates = tools.map((t) => t.startDate).filter(Boolean).sort();
  const since = dates[0] || '—';

  // per-department monthly (active only). Common tools spread their cost across the
  // departments named in their per-department split (user, 2026-08-21).
  const byDept = {};
  activeTools.forEach((t) => {
    if (t.common && t.deptCosts && Object.keys(t.deptCosts).length) {
      for (const [d, amt] of Object.entries(t.deptCosts)) byDept[d] = (byDept[d] || 0) + amtInr(amt, t.currency);
    } else {
      const d = t.department || 'General';
      byDept[d] = (byDept[d] || 0) + toolMonthlyInr(t);
    }
  });
  const budgets = (state.boot && state.boot.toolBudgets) || {};
  // every department that has either spend or an allocated budget
  const deptNames = [...new Set([...Object.keys(byDept), ...Object.keys(budgets)])];
  const deptRows = deptNames
    .map((d) => ({ d, spend: byDept[d] || 0, budget: Number(budgets[d]) || 0 }))
    .sort((a, b) => (b.budget || b.spend) - (a.budget || a.spend))
    .map(({ d, spend, budget }) => {
      const over = budget > 0 && spend > budget;
      const budgetTxt = budget > 0
        ? `<span class="tb-budget ${over ? 'over' : 'ok'}">${inr(spend)} / ${inr(budget)}${over ? ' ⚠' : ''}</span>`
        : `<span class="val">${inr(spend)}</span>`;
      return `<div class="prow"><span>${esc(d)}</span>${budgetTxt}</div>`;
    }).join('');

  const totalBudget = Object.values(budgets).reduce((s, v) => s + (Number(v) || 0), 0);

  const stat = (label, val, sub) => `<div class="cum-stat"><div class="label">${label}</div><div class="value">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('#toolsCumulative').innerHTML = `
    <h3>Spend summary</h3>
    ${stat('Active tools', activeTools.length, stoppedTools.length ? stoppedTools.length + ' stopped' : '')}
    ${stat('Monthly recurring', inr(monthlyActive), '≈ ' + usd(monthlyActive))}
    ${stat('Spent to date', inr(spentAll), 'since ' + since)}
    ${stat('Annualised', inr(monthlyActive * 12), '≈ ' + usd(monthlyActive * 12))}
    ${totalBudget > 0 ? stat('Monthly budget', inr(totalBudget), monthlyActive > totalBudget ? 'over by ' + inr(monthlyActive - totalBudget) : inr(totalBudget - monthlyActive) + ' left') : ''}
    ${deptRows ? `<h3 style="margin-top:16px">Monthly by department${totalBudget > 0 ? ' <span class="muted small">(spend / budget)</span>' : ''}</h3><div class="cum-list">${deptRows}</div>` : ''}
    <p class="muted small" style="margin-top:12px">Spend to date = monthly cost × months since start (until stop date for stopped tools). Budgets are set by Super Admin under Assumptions.</p>`;
}

async function toggleToolActive(id) {
  const t = (state.boot.tools || []).find((x) => x.id === id);
  if (!t) return;
  const nowStop = t.active !== false; // currently active → stopping
  const payload = { active: !nowStop };
  if (nowStop) payload.stopDate = new Date().toISOString().slice(0, 10);
  await api('/tools/' + id, { method: 'PUT', body: JSON.stringify(payload) });
  state.boot.tools = await api('/tools');
  renderTools();
  toast(nowStop ? 'Tool stopped' : 'Tool resumed');
}

function editTool(id) {
  const t = id ? (state.boot.tools || []).find((x) => x.id === id) : null;
  // Only Super Admin gets the "common tool" option (user, 2026-08-21).
  const isSuper = !!state.roleInfo.canEditSettings;
  const depts = [...(state.boot.wings || []), 'General', 'All departments'];
  const curDept = t ? t.department : 'General';
  const deptOpts = [...new Set([curDept, ...depts])].map((d) => `<option value="${esc(d)}" ${t && t.department === d ? 'selected' : ''}>${esc(d)}</option>`).join('');
  // Departments a common tool's cost can be split across.
  const splitDepts = [...new Set([...(state.boot.wings || []), 'General', ...Object.keys((t && t.deptCosts) || {})])];
  const existingSplit = (t && t.deptCosts) || {};
  const dcKey = (d) => 'tdc_' + d.replace(/[^a-z0-9]/gi, '_');
  const body = el('div');
  body.innerHTML = `
    <label class="field"><span>Tool name</span><input id="t_name" value="${t ? esc(t.name) : ''}" placeholder="e.g. Ahrefs" /></label>
    <label class="field"><span>What is it?</span><textarea id="t_desc" rows="2" placeholder="Short description">${t ? esc(t.description) : ''}</textarea></label>
    <div class="field-row">
      <label class="field" id="t_costWrap"><span>Cost / month</span><input id="t_cost" type="number" min="0" step="0.01" value="${t ? (t.cost || 0) : ''}" placeholder="0" /></label>
      <label class="field"><span>Currency</span>
        <select id="t_cur">
          <option value="USD" ${!t || t.currency !== 'INR' ? 'selected' : ''}>USD ($)</option>
          <option value="INR" ${t && t.currency === 'INR' ? 'selected' : ''}>INR (₹)</option>
        </select>
      </label>
    </div>
    <div class="field-row">
      <label class="field"><span>Start date</span><input id="t_start" type="date" value="${t ? (t.startDate || '') : ''}" /></label>
      <label class="field"><span>Stop date (optional)</span><input id="t_stop" type="date" value="${t ? (t.stopDate || '') : ''}" /></label>
    </div>
    ${isSuper ? `<label class="field checkbox"><input id="t_common" type="checkbox" ${t && t.common ? 'checked' : ''} /> <span>Common tool — cost budgeted per department (Super Admin)</span></label>` : ''}
    <label class="field" id="t_deptWrap"><span>Department</span><select id="t_dept">${deptOpts}</select></label>
    <div class="field" id="t_deptCostsWrap" style="display:none">
      <span>Cost by department (per month) — the tool's total is the sum</span>
      <div id="t_deptCosts" class="grid-form small">${splitDepts.map((d) => `<label>${esc(d)}<input id="${dcKey(d)}" data-dept="${esc(d)}" class="tdc-input" type="number" min="0" step="0.01" value="${existingSplit[d] || ''}" placeholder="0" /></label>`).join('')}</div>
      <div class="muted small" style="margin-top:6px">Total: <b id="t_deptTotal">0</b> / mo <span id="t_deptCur"></span></div>
    </div>
    <label class="field"><span>Why is it needed?</span><textarea id="t_why" rows="2" placeholder="Reason / use case">${t ? esc(t.why) : ''}</textarea></label>`;

  const commonEl = () => $('#t_common');
  const isCommon = () => !!(commonEl() && commonEl().checked);
  const recalcSplit = () => {
    let total = 0;
    $$('.tdc-input', body).forEach((i) => { total += Number(i.value) || 0; });
    const cur = $('#t_cur').value === 'INR' ? '₹' : '$';
    $('#t_deptTotal').textContent = cur + total.toLocaleString('en-US');
  };
  // A common tool has no single department and no single cost — its cost is split
  // per department instead.
  const syncCommon = () => {
    const on = isCommon();
    $('#t_deptWrap').style.display = on ? 'none' : '';
    $('#t_costWrap').style.display = on ? 'none' : '';
    $('#t_deptCostsWrap').style.display = on ? '' : 'none';
    if (on) recalcSplit();
  };

  openModal(id ? 'Edit tool' : 'New tool', body, async () => {
    const name = $('#t_name').value.trim();
    if (!name) { toast('Tool name required'); return false; }
    const common = isCommon();
    const payload = {
      name,
      description: $('#t_desc').value,
      currency: $('#t_cur').value,
      common,
      why: $('#t_why').value,
      startDate: $('#t_start').value,
      stopDate: $('#t_stop').value,
    };
    if (common) {
      const deptCosts = {};
      $$('.tdc-input', body).forEach((i) => { const v = Number(i.value) || 0; if (v > 0) deptCosts[i.dataset.dept] = v; });
      payload.deptCosts = deptCosts;
      payload.department = 'All departments';
    } else {
      payload.cost = Number($('#t_cost').value) || 0;
      payload.department = $('#t_dept').value;
    }
    if (id) await api('/tools/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/tools', { method: 'POST', body: JSON.stringify(payload) });
    state.boot.tools = await api('/tools');
    renderTools();
    toast('Saved');
    return true;
  });
  if (commonEl()) commonEl().onchange = syncCommon;
  $$('.tdc-input', body).forEach((i) => (i.oninput = recalcSplit));
  $('#t_cur').addEventListener('change', recalcSplit);
  syncCommon();
}

async function deleteTool(id) {
  const t = (state.boot.tools || []).find((x) => x.id === id);
  if (!confirm(`Delete “${t ? t.name : 'this tool'}”?`)) return;
  await api('/tools/' + id, { method: 'DELETE' });
  state.boot.tools = await api('/tools');
  renderTools();
  toast('Deleted');
}

// ================= CLIENTS =================
function renderAccounts() {
  if (isSuper()) renderAccountsSuper();
  else renderAccountsDept();
}

// Super: one row per client NAME with a checkbox per department, plus rename/delete.
function renderAccountsSuper() {
  const wings = state.boot.wings || [];
  const groups = clientGroups();
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const head = ['Client', 'Departments', ''];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i < 2 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  if (!names.length) html += `<tr><td colspan="3" class="l muted">No clients yet. Use “+ New client”.</td></tr>`;
  names.forEach((name) => {
    const accs = groups.get(name) || [];
    const has = (w) => accs.some((a) => (a.wing || '') === w);
    const unassigned = accs.some((a) => !a.wing)
      ? '<span class="tag-common" title="No department yet — tick a box to assign">Unassigned</span> ' : '';
    const allOn = wings.length > 0 && wings.every((w) => has(w));
    const boxes = wings.map((w) =>
      `<label class="dept-box"><input type="checkbox" class="dept-cb" data-name="${esc(name)}" data-wing="${esc(w)}" ${has(w) ? 'checked' : ''}/> ${esc(w)}</label>`).join('');
    const allBtn = `<button class="btn btn-sm dept-all" data-name="${esc(name)}" data-on="${allOn ? '1' : '0'}" title="${allOn ? 'Remove this client from every department' : 'Add this client to every department'}">${allOn ? '✕ None' : '✓ All'}</button>`;
    html += `<tr>
      <td class="l"><b>${esc(name)}</b></td>
      <td class="l"><div class="dept-boxes">${allBtn}${unassigned}${boxes}</div></td>
      <td class="client-actions">
        <button class="btn btn-sm rename-client" data-name="${esc(name)}">Rename</button>
        <button class="btn btn-sm btn-danger del-client" data-name="${esc(name)}">Delete</button>
      </td>
    </tr>`;
  });
  $('#accountsTable').innerHTML = html + '</tbody>';
  $$('.dept-cb').forEach((cb) => (cb.onchange = () => toggleClientDept(cb.dataset.name, cb.dataset.wing, cb.checked)));
  $$('.dept-all').forEach((b) => (b.onclick = () => setAllClientDepts(b.dataset.name, b.dataset.on !== '1')));
  $$('.rename-client').forEach((b) => (b.onclick = () => renameClient(b.dataset.name)));
  $$('.del-client').forEach((b) => (b.onclick = () => deleteClient(b.dataset.name)));
  $('#addAccountBtn').classList.remove('hidden');
}

// Departments: read-only list of their own clients (add via the button; no edit/delete).
function renderAccountsDept() {
  const ro = !!state.roleInfo.readOnly;
  const groups = clientGroups();
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const head = ['Client', 'Department'];
  let html = '<thead><tr>' + head.map((h) => `<th class="l">${h}</th>`).join('') + '</tr></thead><tbody>';
  if (!names.length) html += `<tr><td colspan="2" class="l muted">No clients in your department yet.${ro ? '' : ' Use “+ New client”.'}</td></tr>`;
  names.forEach((name) => {
    const accs = groups.get(name) || [];
    const depts = accs.map((a) => esc(a.wing || 'Unassigned')).join(', ');
    html += `<tr><td class="l">${esc(name)}</td><td class="l">${depts}</td></tr>`;
  });
  $('#accountsTable').innerHTML = html + '</tbody>';
  $('#addAccountBtn').classList.toggle('hidden', ro || !state.roleInfo.canCreateAccounts);
}

// Super — tick/untick a department for a client. Ticking repurposes an unassigned
// row if there is one (keeping its data), else creates a new one; unticking deletes
// that department's account (and its data) after a confirm.
async function toggleClientDept(name, wing, checked) {
  try {
    const accs = clientGroups().get(name) || [];
    if (checked) {
      const empty = accs.find((a) => !a.wing);
      if (empty) await api('/accounts/' + empty.id, { method: 'PUT', body: JSON.stringify({ wing }) });
      else await api('/accounts', { method: 'POST', body: JSON.stringify({ name, wing }) });
    } else {
      const acc = accs.find((a) => (a.wing || '') === wing);
      if (acc) {
        if (!confirm(`Remove “${name}” from ${wing}? Any ${wing} data for this client will be permanently deleted.`)) { renderAccounts(); return; }
        await api('/accounts/' + acc.id, { method: 'DELETE' });
      }
    }
    state.boot = await api('/bootstrap');
    renderAccounts();
    toast('Saved');
  } catch (e) { toast(e.message); renderAccounts(); }
}

// Super — tick (or clear) EVERY department for a client at once. Batches the account
// creates/repurposes (or deletes) and refreshes once at the end (user, 2026-08-24).
async function setAllClientDepts(name, checked) {
  const wings = state.boot.wings || [];
  if (!wings.length) return;
  const accs = clientGroups().get(name) || [];
  try {
    if (checked) {
      const missing = wings.filter((w) => !accs.some((a) => (a.wing || '') === w));
      if (!missing.length) { toast('Already in every department'); return; }
      const empties = accs.filter((a) => !a.wing); // repurpose empty-wing rows first, keeping their data
      for (const w of missing) {
        const empty = empties.shift();
        if (empty) await api('/accounts/' + empty.id, { method: 'PUT', body: JSON.stringify({ wing: w }) });
        else await api('/accounts', { method: 'POST', body: JSON.stringify({ name, wing: w }) });
      }
    } else {
      const assigned = accs.filter((a) => a.wing);
      if (!assigned.length) { toast('No departments to clear'); return; }
      if (!confirm(`Remove “${name}” from ALL departments? Every department's data for this client will be permanently deleted.`)) return;
      for (const a of assigned) await api('/accounts/' + a.id, { method: 'DELETE' });
    }
    state.boot = await api('/bootstrap');
    renderAccounts();
    toast(checked ? 'Added to every department' : 'Removed from every department');
  } catch (e) { toast(e.message); renderAccounts(); }
}

function renameClient(name) {
  const body = el('div');
  body.innerHTML = `<label class="field"><span>Client name</span><input id="m_name" value="${esc(name)}" /></label>
    <p class="muted small">Renames this client across every department it belongs to.</p>`;
  openModal('Rename client', body, async () => {
    const nn = $('#m_name').value.trim();
    if (!nn) { toast('Name required'); return false; }
    const accs = clientGroups().get(name) || [];
    for (const a of accs) await api('/accounts/' + a.id, { method: 'PUT', body: JSON.stringify({ name: nn }) });
    state.boot = await api('/bootstrap'); renderAccounts(); toast('Renamed'); return true;
  });
}

async function deleteClient(name) {
  if (!confirm(`Delete client “${name}” and ALL its data across every department? This cannot be undone.`)) return;
  const accs = clientGroups().get(name) || [];
  try {
    for (const a of accs) await api('/accounts/' + a.id, { method: 'DELETE' });
    state.boot = await api('/bootstrap'); renderAccounts(); toast('Client deleted');
  } catch (e) { toast(e.message); }
}

$('#addAccountBtn').addEventListener('click', newClient);

// New client. Super picks any set of departments; a department role is locked to its
// own department (it can only add, never choose another department — user 2026-08-21).
function newClient() {
  const body = el('div');
  if (isSuper()) {
    const wings = state.boot.wings || [];
    body.innerHTML = `
      <label class="field"><span>Client name</span><input id="m_name" placeholder="Client name" /></label>
      <div class="field"><span>Departments</span>
        <div class="dept-boxes modal-boxes">${wings.map((w) => `<label class="dept-box"><input type="checkbox" class="new-dept" value="${esc(w)}"/> ${esc(w)}</label>`).join('')}</div>
      </div>
      <p class="muted small">Tick the departments this client belongs to — you can change these any time.</p>`;
    openModal('New client', body, async () => {
      const name = $('#m_name').value.trim();
      if (!name) { toast('Name required'); return false; }
      const picked = $$('.new-dept', body).filter((c) => c.checked).map((c) => c.value);
      if (!picked.length) { toast('Pick at least one department'); return false; }
      for (const w of picked) await api('/accounts', { method: 'POST', body: JSON.stringify({ name, wing: w }) });
      state.boot = await api('/bootstrap'); renderAccounts(); toast('Client added'); return true;
    });
  } else {
    const own = (state.roleInfo.wings && state.roleInfo.wings.length) ? state.roleInfo.wings : [];
    const wingField = own.length > 1
      ? `<label class="field"><span>Department</span><select id="m_wing">${own.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('')}</select></label>`
      : '';
    const note = own.length === 1
      ? `<p class="muted small">Added under your department: <b>${esc(own[0])}</b>.</p>`
      : (own.length ? '' : `<p class="error">Your role has no department assigned — ask Super Admin.</p>`);
    body.innerHTML = `<label class="field"><span>Client name</span><input id="m_name" placeholder="Client name" /></label>${wingField}${note}`;
    openModal('New client', body, async () => {
      const name = $('#m_name').value.trim();
      if (!name) { toast('Name required'); return false; }
      if (!own.length) { toast('No department assigned to your role'); return false; }
      const wing = own.length > 1 ? $('#m_wing').value : own[0];
      await api('/accounts', { method: 'POST', body: JSON.stringify({ name, wing }) });
      state.boot = await api('/bootstrap'); renderAccounts(); toast('Client added'); return true;
    });
  }
}

// ================= ASSUMPTIONS (super only) =================
function renderJobTypes() {
  const box = $('#jobTypesList');
  if (!box) return;
  const list = state.jobTypesEdit || [];
  box.innerHTML = list.length
    ? list.map((j, i) => `<span class="jt-chip">${esc(j)}<button type="button" class="chip-x" data-i="${i}" title="Remove">✕</button></span>`).join('')
    : '<p class="muted small">No options yet — add one below.</p>';
  $$('.chip-x', box).forEach((b) => (b.onclick = () => {
    state.jobTypesEdit.splice(Number(b.dataset.i), 1);
    renderJobTypes();
  }));
}

async function renderSettings() {
  if (!state.roleInfo.canEditSettings) return;
  const s = await api('/settings');
  const a = s.assumptions;
  const af = $('#assumptionsForm');
  const fld = (id, label, val, step = '1') => `<label>${label}<input id="${id}" type="number" step="${step}" value="${val}" /></label>`;
  const midRate = a.midRate != null ? a.midRate : Math.round(((+a.srRate || 0) + (+a.jrRate || 0)) / 2);
  af.innerHTML =
    fld('a_srRate', 'Senior rate (₹/hr)', a.srRate) +
    fld('a_midRate', 'Middle rate (₹/hr)', midRate) +
    fld('a_jrRate', 'Junior rate (₹/hr)', a.jrRate) +
    fld('a_srCap', 'Sr capacity (hrs/mo)', a.srCapacity) +
    fld('a_jrCap', 'Jr capacity (hrs/mo)', a.jrCapacity) +
    fld('a_resCap', 'Hours per resource / month', a.resourceMonthlyHours || 180) +
    fld('a_min', 'GM min % (At Risk below)', Math.round(a.gmMin * 100)) +
    fld('a_healthy', 'GM healthy % (✅ at/above)', Math.round(a.gmHealthy * 100));
  $('#saveAssumptions').onclick = async () => {
    await api('/settings/assumptions', { method: 'PUT', body: JSON.stringify({
      srRate: +$('#a_srRate').value, midRate: +$('#a_midRate').value, jrRate: +$('#a_jrRate').value,
      srCapacity: +$('#a_srCap').value, jrCapacity: +$('#a_jrCap').value,
      resourceMonthlyHours: +$('#a_resCap').value || 180,
      gmMin: (+$('#a_min').value) / 100, gmHealthy: (+$('#a_healthy').value) / 100,
    }) });
    state.boot = await api('/bootstrap'); renderFx(); toast('Assumptions saved');
  };

  // team / resources manager button
  $('#manageTeamBtn').onclick = manageTeam;

  const tp = $('#toolPoolForm');
  tp.innerHTML = s.months.map((m) => `<label>${m}<input id="tp_${m}" type="number" value="${(s.toolPool && s.toolPool[m]) || 0}" /></label>`).join('');
  $('#saveToolPool').onclick = async () => {
    const payload = {};
    s.months.forEach((m) => { payload[m] = +$('#tp_' + m).value || 0; });
    await api('/settings/toolpool', { method: 'PUT', body: JSON.stringify(payload) });
    toast('Tool pool saved');
  };

  // tool budget by department (super only) — drives spend-vs-budget on Tools page
  const tb = $('#toolBudgetForm');
  if (tb) {
    const budgets = s.toolBudgets || {};
    const depts = [...new Set([...(s.wings || []), 'General', 'All departments', ...Object.keys(budgets)])];
    const key = (d) => 'tb_' + d.replace(/[^a-z0-9]/gi, '_');
    tb.innerHTML = depts.map((d) => `<label>${esc(d)}<input id="${key(d)}" type="number" min="0" value="${Number(budgets[d]) || 0}" /></label>`).join('');
    $('#saveToolBudgets').onclick = async () => {
      const payload = {};
      depts.forEach((d) => { payload[d] = +$('#' + key(d)).value || 0; });
      const saved = await api('/settings/toolbudgets', { method: 'PUT', body: JSON.stringify({ budgets: payload }) });
      state.boot.toolBudgets = saved;
      toast('Tool budgets saved');
    };
  }

  // outsourcing options (job types) — Super can add / remove
  state.jobTypesEdit = (s.jobTypes || []).slice();
  renderJobTypes();
  $('#jt_add').onclick = () => {
    const v = $('#jt_new').value.trim();
    if (!v) return;
    if ((state.jobTypesEdit || []).some((x) => x.toLowerCase() === v.toLowerCase())) { toast('Already in the list'); return; }
    state.jobTypesEdit.push(v); $('#jt_new').value = ''; renderJobTypes();
  };
  $('#jt_new').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#jt_add').click(); } };
  $('#saveJobTypes').onclick = async () => {
    if (!(state.jobTypesEdit || []).length) { toast('Keep at least one option'); return; }
    const list = await api('/settings/jobtypes', { method: 'PUT', body: JSON.stringify({ jobTypes: state.jobTypesEdit }) });
    state.boot.jobTypes = list; toast('Outsourcing list saved');
  };

  // help bot (Groq) — super only
  const hb = $('#helpBotForm');
  if (hb) {
    let cfg = { hasKey: false, envKey: false, model: 'llama-3.3-70b-versatile' };
    try { cfg = await api('/settings/help'); } catch { /* ignore */ }
    const models = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct'];
    if (cfg.model && !models.includes(cfg.model)) models.unshift(cfg.model);
    hb.innerHTML =
      `<label>Groq API key ${cfg.hasKey ? `<span class="muted small">(a key is set${cfg.envKey ? ' via env' : ''})</span>` : ''}<input id="hb_key" type="password" autocomplete="off" placeholder="${cfg.hasKey ? '•••••• leave blank to keep' : 'gsk_…'}" /></label>` +
      `<label>Model<select id="hb_model">${models.map((m) => `<option value="${esc(m)}" ${m === cfg.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>`;
    $('#saveHelpBot').onclick = async () => {
      const payload = { model: $('#hb_model').value };
      const key = $('#hb_key').value;
      if (key) payload.apiKey = key;
      try {
        const saved = await api('/settings/help', { method: 'PUT', body: JSON.stringify(payload) });
        state.boot.helpEnabled = saved.hasKey;
        $('#hb_key').value = '';
        updateHelpFab();
        toast('Help bot saved');
      } catch (e) { toast(e.message); }
    };
  }

  const pf = $('#passwordForm');
  pf.innerHTML = Object.entries(state.boot.roles).map(([role, label]) =>
    `<div class="pw-row"><input type="password" id="pw_${role}" placeholder="New password for ${label}" />
     <button class="btn btn-sm" data-role="${role}">Set</button></div>`).join('');
  $$('#passwordForm button').forEach((b) => (b.onclick = async () => {
    const role = b.dataset.role; const v = $('#pw_' + role).value;
    if (!v || v.length < 4) { toast('Min 4 characters'); return; }
    await api('/settings/password', { method: 'PUT', body: JSON.stringify({ role, newPassword: v }) });
    $('#pw_' + role).value = ''; toast(state.boot.roles[role] + ' password updated');
  }));

  // Backup — fetch the full store as a file and save it. Can't use api() (that
  // parses JSON); we need the raw body as a downloadable blob with the auth header.
  const dl = $('#downloadBackup');
  if (dl) dl.onclick = async () => {
    try {
      const res = await fetch('/api/backup', { headers: { Authorization: 'Bearer ' + state.token } });
      if (res.status === 401) { logout(); return; }
      if (!res.ok) { toast('Backup failed'); return; }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const name = m ? m[1] : `bngm-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = el('a'); a.href = url; a.download = name; document.body.appendChild(a);
      a.click(); a.remove(); URL.revokeObjectURL(url);
      toast('Backup downloaded');
    } catch (e) { toast(e.message || 'Backup failed'); }
  };
}

// ================= HELP BOT (Groq) =================
const help = { messages: [], busy: false };

function updateHelpFab() {
  const fab = $('#helpFab');
  if (!fab) return;
  const on = !!(state.boot && state.boot.helpEnabled) && !!state.token;
  fab.classList.toggle('hidden', !on);
  if (!on) { $('#helpPanel').classList.add('hidden'); }
}

function renderHelpLog() {
  const log = $('#helpLog');
  if (!log) return;
  if (!help.messages.length) {
    log.innerHTML = `<div class="help-msg bot">Hi! Ask me how to use the tracker or about your reports — e.g. “How do I log actual hours?” or “What’s my YTD gross margin?”</div>`;
    return;
  }
  log.innerHTML = help.messages.map((m) =>
    `<div class="help-msg ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.content).replace(/\n/g, '<br>')}</div>`).join('') +
    (help.busy ? '<div class="help-msg bot muted">…thinking</div>' : '');
  log.scrollTop = log.scrollHeight;
}

async function sendHelp() {
  const inp = $('#helpText');
  const q = inp.value.trim();
  if (!q || help.busy) return;
  help.messages.push({ role: 'user', content: q });
  inp.value = '';
  help.busy = true;
  renderHelpLog();
  try {
    const r = await api('/help', { method: 'POST', body: JSON.stringify({ messages: help.messages }) });
    help.messages.push({ role: 'assistant', content: r.reply || '(no answer)' });
  } catch (e) {
    help.messages.push({ role: 'assistant', content: '⚠️ ' + e.message });
  } finally {
    help.busy = false;
    renderHelpLog();
  }
}

(function wireHelpBot() {
  const fab = $('#helpFab');
  if (!fab) return;
  fab.addEventListener('click', () => {
    const panel = $('#helpPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) { renderHelpLog(); $('#helpText').focus(); }
  });
  $('#helpClose').addEventListener('click', () => $('#helpPanel').classList.add('hidden'));
  $('#helpSend').addEventListener('click', sendHelp);
  $('#helpText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendHelp(); });
})();

// ================= MODAL =================
let modalOk = null;
function openModal(title, bodyNode, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = ''; $('#modalBody').appendChild(bodyNode);
  modalOk = onOk;
  $('#modalActions').classList.remove('hidden');
  $('#modal').classList.remove('hidden');
}
// modal with no OK/Cancel footer (its own inline buttons manage everything)
function openModalCustom(title, bodyNode) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = ''; $('#modalBody').appendChild(bodyNode);
  modalOk = null;
  $('#modalActions').classList.add('hidden');
  $('#modal').classList.remove('hidden');
}
$('#modalCancel').onclick = () => $('#modal').classList.add('hidden');
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');
$('#modalOk').onclick = async () => {
  if (modalOk) { const close = await modalOk(); if (close === false) return; }
  $('#modal').classList.add('hidden');
};

// ---------------- boot ----------------
(async function init() {
  if (state.token) {
    try { await startApp(); } catch { logout(); }
  }
})();
