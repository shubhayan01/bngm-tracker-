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
  $$('.settings-only').forEach((e) => e.classList.toggle('hidden', !state.roleInfo.canEditSettings));
  $('#addToolBtn').classList.toggle('hidden', !state.roleInfo.canManageTools);

  // Read-only roles (Admin) get reports only — hide the Update tab and any
  // create buttons, and land on the dashboard.
  const ro = !!state.roleInfo.readOnly;
  $$('#tabs .tab[data-view="entry"]').forEach((t) => t.classList.toggle('hidden', ro));
  $('#addAccountBtn').classList.toggle('hidden', ro || !state.roleInfo.canCreateAccounts);
  if (ro) { switchView('dashboard'); return; }

  switchView('entry');
  startEntry();
}

// ---------------- nav ----------------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab'); if (!btn) return;
  switchView(btn.dataset.view);
});
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
const entry = { accountId: null, month: null, mode: 'actual', data: null };

const F = () => entry.mode === 'planned'
  ? { rev: 'revPlanned', wc: 'wcPlanned', res: 'resourcesPlan' }
  : { rev: 'revActual', wc: 'wcDelivered', res: 'resourcesActual' };

function isSenior(assoc) {
  return assoc && !String(assoc.type || '').toLowerCase().startsWith('jr') && !/junior/i.test(String(assoc && assoc.type));
}
function activeAccounts() {
  return (state.boot.accounts || []).filter((a) => a.active !== false);
}
function currentMonthLabel() {
  const d = new Date();
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const yy = String(d.getFullYear()).slice(2);
  const label = `${mon}-${yy}`;
  return (state.boot.months || []).includes(label) ? label : (state.boot.months || [])[0];
}

function startEntry() {
  const accs = activeAccounts();
  const clientSel = $('#e_client');
  clientSel.innerHTML = '<option value="">— select client —</option>' +
    accs.map((a) => `<option value="${a.id}">${esc(a.name)}${a.wing ? ' · ' + esc(a.wing) : ''}</option>`).join('');
  if (entry.accountId && accs.some((a) => a.id === entry.accountId)) clientSel.value = String(entry.accountId);

  const monthSel = $('#e_month');
  monthSel.innerHTML = (state.boot.months || []).map((m) => `<option value="${m}">${m}</option>`).join('');
  entry.month = entry.month || currentMonthLabel();
  monthSel.value = entry.month;

  setModeButtons();
  clientSel.onchange = () => { entry.accountId = Number(clientSel.value) || null; loadEntry(); };
  monthSel.onchange = () => { entry.month = monthSel.value; loadEntry(); };
  $$('#e_mode button').forEach((b) => (b.onclick = () => { entry.mode = b.dataset.mode; setModeButtons(); loadEntry(); }));

  if (entry.accountId) loadEntry();
  else { $('#entryBody').innerHTML = '<p class="muted entry-hint">Pick a client above to begin — then everything is one screen.</p>'; renderPreview(); }
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
  entry.data.resourcesActual = Array.isArray(entry.data.resourcesActual) ? entry.data.resourcesActual : [];
  entry.data.resourcesPlan = Array.isArray(entry.data.resourcesPlan) ? entry.data.resourcesPlan : [];
  entry.data.outsourcing = Array.isArray(entry.data.outsourcing) ? entry.data.outsourcing : [];
  renderEntryBody();
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
  cont.innerHTML = ids.map((id) => {
    const a = assocById(id);
    const email = a ? a.name : ('#' + id);
    const used = usageOther[id] || 0;
    const cur = resHours(id) || 0;
    const maxForThis = Math.max(0, cap - used);
    const full = cap - used - cur <= 0;
    return `
    <label class="res-row ${full ? 'res-full' : ''}" data-id="${id}">
      <span class="res-name">${esc(email)}${a ? '' : ' <span class="muted small">(removed)</span>'}</span>
      <input type="number" min="0" max="${maxForThis}" step="1" class="res-hrs" data-id="${id}"
             value="${cur || ''}" placeholder="0 hrs" />
      <span class="res-avail muted">${availLabel(used, cur, cap)}</span>
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
      `<div class="res-match" data-id="${a.id}">${esc(a.name)}<span class="muted small"> · ${isSenior(a) ? 'Senior' : 'Junior'}</span></div>`).join('');
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
  // the user has just picked from the email search (even before typing hours).
  entry.picked = new Set((resArr() || []).map((r) => Number(r.id)));

  const body = `
    ${exists ? `<div class="entry-flag">✎ Editing existing ${entry.mode} numbers — adjust anything and save.</div>` : ''}

    <div class="entry-field">
      <label class="ef-label">Revenue (₹) — ${entry.mode === 'planned' ? 'planned / budget' : 'actual billed'}</label>
      <input id="e_rev" type="number" min="0" step="1" value="${entry.data[f.rev] || ''}" placeholder="e.g. 185000" />
      <div class="usd-hint usd">≈ <span id="e_rev_usd"></span></div>
    </div>

    <div class="entry-field">
      <div class="ef-head">
        <label class="ef-label">Resources (${entry.mode} hours)</label>
        ${canManageTeam ? `<button type="button" id="e_manageTeam" class="btn btn-sm btn-ghost" title="Add or adjust who is senior / junior">⚙ Manage team</button>` : ''}
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
      <label class="ef-label">Outsourcing / freelance costs</label>
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
      <label class="ef-label">Notes (optional)</label>
      <input id="e_notes" value="${esc(entry.data.notes || '')}" placeholder="Anything worth remembering…" />
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
    entry.data.outsourcing.push({ jobType: $('#e_outType').value, cost, vendor: '' });
    $('#e_outCost').value = '';
    renderOutsourcing(); renderPreview();
  };

  const wc = $('#e_wc'); if (wc) wc.oninput = () => { entry.data[f.wc] = Number(wc.value) || 0; };
  $('#e_notes').oninput = () => { entry.data.notes = $('#e_notes').value; };
  $('#e_save').onclick = saveEntry;

  renderPreview();
}

// Legacy entries carry aggregate sr/jr hours with no per-person breakdown.
function legacyHoursNote() {
  const d = entry.data;
  const sr = entry.mode === 'planned' ? d.srHrsPlan : d.srHrs;
  const jr = entry.mode === 'planned' ? d.jrHrsPlan : d.jrHrs;
  const hasBreakdown = (d[F().res] || []).length > 0;
  if (hasBreakdown || (!sr && !jr)) return '';
  return `<div class="entry-flag" style="background:color-mix(in srgb,var(--amber) 12%,transparent);border-color:color-mix(in srgb,var(--amber) 34%,transparent);color:var(--amber)">
    Saved earlier as totals: ${sr || 0} senior + ${jr || 0} junior hrs (no per-person split). These stay as-is unless you enter per-person hours below, which will replace them.</div>`;
}

function renderOutsourcing() {
  const list = $('#e_outList');
  const arr = entry.data.outsourcing || [];
  if (!arr.length) { list.innerHTML = '<p class="muted" style="margin:4px 0">None added.</p>'; return; }
  list.innerHTML = arr.map((o, i) => `
    <div class="out-row">
      <span>${esc(o.jobType)}</span>
      <span class="val">${inr(o.cost)}</span>
      <button type="button" class="btn btn-sm btn-danger out-del" data-i="${i}">✕</button>
    </div>`).join('');
  $$('.out-del').forEach((b) => (b.onclick = () => {
    entry.data.outsourcing.splice(Number(b.dataset.i), 1);
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
      outsourcing: entry.data.outsourcing || [],
      notes: entry.data.notes || '',
    };
    if ((entry.data[f.res] || []).length) payload[f.res] = entry.data[f.res];
    const acc = state.boot.accounts.find((a) => a.id === entry.accountId);
    if (acc && acc.wing === 'Content Creation') payload[f.wc] = Number(entry.data[f.wc]) || 0;
    const r = await api('/entry', { method: 'PUT', body: JSON.stringify(payload) });
    entry.data = r.entry;
    if (r.capacity) entry.capacity = r.capacity;
    if (r.usageOther) entry.usageOther = r.usageOther;
    entry.data.resourcesActual = entry.data.resourcesActual || [];
    entry.data.resourcesPlan = entry.data.resourcesPlan || [];
    entry.data.outsourcing = entry.data.outsourcing || [];
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
    manpower += (Number(r.hours) || 0) * (isSenior(assoc) ? a.srRate : a.jrRate);
  }
  const outsourcing = (d.outsourcing || []).reduce((s, o) => s + (Number(o.cost) || 0), 0);
  const contingency = revenue * a.contingency;
  const totalCost = manpower + outsourcing + contingency;
  const grossProfit = revenue - totalCost;
  const gm = revenue > 0 ? grossProfit / revenue : 0;
  let status = 'none';
  if (revenue > 0) status = gm >= a.gmHealthy ? 'healthy' : gm >= a.gmMin ? 'review' : 'atrisk';
  return { revenue, manpower, outsourcing, toolShare: 0, contingency, totalCost, grossProfit, gm, status, approx: true };
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
    row('Contingency', '− ' + inr(c.contingency)) +
    `<div class="prow total"><span>Gross profit</span><span class="val">${inrUsd(c.grossProfit)}</span></div>` +
    `<div class="gm-badge st-${c.status}">GM ${pct(c.gm)} · ${stName}</div>` +
    (c.approx ? '<p class="muted" style="font-size:11px;margin-top:10px">* tool-share is apportioned across accounts when you save.</p>' : '');
}

// ---- team / resource manager (add / adjust senior vs junior) ----
function manageTeam() {
  const render = () => {
    const list = state.boot.associates || [];
    const rows = list.map((p) => `
      <div class="team-row" data-id="${p.id}">
        <input class="tm-name" type="email" value="${esc(p.name)}" placeholder="email@domain" />
        <select class="tm-type">
          <option value="Sr. Resource" ${isSenior(p) ? 'selected' : ''}>Senior</option>
          <option value="Jr. Resource" ${!isSenior(p) ? 'selected' : ''}>Junior</option>
        </select>
        <button class="btn btn-sm tm-save">Save</button>
        <button class="btn btn-sm btn-danger tm-del">✕</button>
      </div>`).join('');
    const body = el('div');
    body.innerHTML = `
      <p class="muted">The team is loaded from <code>emp details.txt</code>. Each resource is identified by their <b>email</b>; set who counts as a senior or junior resource — this drives the ₹/hr rate used in costing.</p>
      <div id="teamList">${rows || '<p class="muted">No resources yet.</p>'}</div>
      <div class="team-add">
        <input id="tm_newName" type="email" placeholder="New person's email" />
        <select id="tm_newType"><option value="Sr. Resource">Senior</option><option value="Jr. Resource">Junior</option></select>
        <button id="tm_add" class="btn btn-sm btn-primary">+ Add</button>
      </div>`;
    openModalCustom('Manage team / resources', body);
    body.querySelectorAll('.team-row').forEach((rowEl) => {
      const id = Number(rowEl.dataset.id);
      rowEl.querySelector('.tm-save').onclick = async () => {
        await api('/associates/' + id, { method: 'PUT', body: JSON.stringify({ name: rowEl.querySelector('.tm-name').value, type: rowEl.querySelector('.tm-type').value }) });
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
      await api('/associates', { method: 'POST', body: JSON.stringify({ name, type: body.querySelector('#tm_newType').value }) });
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
  renderComparison(d.comparison, d.comparisonYtd);
  renderKpis(d.ytd);
  renderMonthly(d.monthly);
  setupMonthCompare(d.monthly);
  renderWings(d.wingSummary);
  setupRanking(d.ranking);
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

function renderComparison(rows, ytd) {
  // KPI strip
  const k = (label, plan, actual, vr, asPct) => {
    const cls = vr >= 0 ? 'up' : 'down';
    const vtxt = asPct ? (vr > 0 ? '+' : '') + (vr * 100).toFixed(1) + '%' : (vr > 0 ? '+' : '') + inr(vr);
    return `<div class="cmp-kpi">
      <div class="label">${label}</div>
      <div class="cmp-two"><span class="plan">Plan ${asPct ? pct(plan) : inr(plan)}</span><span class="act">Actual ${asPct ? pct(actual) : inr(actual)}</span></div>
      <div class="cmp-var ${cls}">${vtxt}</div>
    </div>`;
  };
  $('#cmpKpis').innerHTML =
    k('Revenue', ytd.planRevenue, ytd.actualRevenue, ytd.revVariance, false) +
    k('Gross profit', ytd.planGP, ytd.actualGP, ytd.gpVariance, false) +
    k('Gross margin', ytd.planGM, ytd.actualGM, ytd.gmVariance, true) +
    k('Cost', ytd.planCost, ytd.actualCost, ytd.actualCost - ytd.planCost, false);

  const head = ['Month', 'Plan Rev', 'Actual Rev', 'Δ Rev', 'Plan GP', 'Actual GP', 'Δ GP', 'Plan GM', 'Actual GM', 'Δ GM'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  const active = (rows || []).filter((r) => r.planRevenue || r.actualRevenue);
  if (!active.length) html += `<tr><td colspan="10" class="l muted">No entries yet.</td></tr>`;
  active.forEach((r) => {
    html += `<tr><td class="l">${r.month}</td>` +
      `<td>${inr(r.planRevenue)}</td><td>${inr(r.actualRevenue)}</td>${varCell(r.revVariance)}` +
      `<td>${inr(r.planGP)}</td><td>${inr(r.actualGP)}</td>${varCell(r.gpVariance)}` +
      `<td>${pct(r.planGM)}</td><td>${pct(r.actualGM)}</td>${varCell(r.gmVariance, true)}</tr>`;
  });
  $('#cmpTable').innerHTML = html + '</tbody>';
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
  rows.forEach((r) => {
    html += `<tr><td class="l">${r.month}</td><td>${inrUsd(r.revenue)}</td>${costCell(r.manpower)}${costCell(r.outsourcing)}${costCell(r.toolShare)}${costCell(r.totalCost)}<td>${inrUsd(r.grossProfit)}</td><td>${pct(r.gm)}</td><td>${r.activeAccounts}</td><td>${r.healthy}</td><td>${r.review}</td><td>${r.atrisk}</td></tr>`;
  });
  $('#monthlyTable').innerHTML = html + '</tbody>';
}

// ---- compare two or more months side by side (user, 2026-08-17) ----
function setupMonthCompare(monthly) {
  state.monthly = monthly || [];
  const pick = $('#cmpMonthsPick');
  if (!pick) return;
  const prev = new Set(state.cmpMonths || []);
  pick.innerHTML = state.monthly.map((m) => {
    const has = m.revenue || m.totalCost;
    return `<label class="mp-chip ${has ? '' : 'mp-empty'}"><input type="checkbox" value="${m.month}" ${prev.has(m.month) ? 'checked' : ''}/> ${m.month}</label>`;
  }).join('');
  $$('#cmpMonthsPick input[type=checkbox]').forEach((cb) => (cb.onchange = onMonthCompareChange));
  const clear = $('#cmpMonthsClear');
  if (clear) clear.onclick = () => { state.cmpMonths = []; setupMonthCompare(state.monthly); };
  renderMonthCompare();
}
function onMonthCompareChange() {
  state.cmpMonths = $$('#cmpMonthsPick input:checked').map((c) => c.value);
  renderMonthCompare();
}
function renderMonthCompare() {
  const tbl = $('#cmpMonthsTable');
  if (!tbl) return;
  const sel = state.cmpMonths || [];
  if (sel.length < 2) {
    tbl.innerHTML = `<tbody><tr><td class="l muted">Tick two or more months above to compare them side by side.</td></tr></tbody>`;
    return;
  }
  const chosen = (state.monthly || []).filter((m) => sel.includes(m.month));
  const head = ['Metric', ...chosen.map((m) => m.month)];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  const line = (label, cells) => `<tr><td class="l">${label}</td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  html += line('Revenue', chosen.map((m) => inrUsd(m.revenue)));
  html += line('Manpower', chosen.map((m) => costSpan(m.manpower)));
  html += line('Outsourcing', chosen.map((m) => costSpan(m.outsourcing)));
  html += line('Tool share', chosen.map((m) => costSpan(m.toolShare)));
  html += line('Total cost', chosen.map((m) => costSpan(m.totalCost)));
  html += line('Gross profit', chosen.map((m) => inrUsd(m.grossProfit)));
  html += line('Gross margin', chosen.map((m) => pct(m.gm)));
  html += line('Active accounts', chosen.map((m) => m.activeAccounts));
  tbl.innerHTML = html + '</tbody>';
}

function renderWings(rows) {
  const head = ['Wing / Dept', 'Revenue', 'Total Cost', 'Gross Profit', 'GM %', 'Status'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  rows.forEach((r) => {
    html += `<tr><td class="l">${r.wing}</td><td>${inrUsd(r.revenue)}</td>${costCell(r.totalCost)}<td>${inrUsd(r.grossProfit)}</td><td>${pct(r.gm)}</td><td>${statusPill(r.status)}</td></tr>`;
  });
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

  const head = ['#', 'Account', 'Wing', 'Revenue', 'Total Cost', 'Gross Profit', 'GM %', 'Target', 'Variance', 'Status'];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i === 1 || i === 2 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  if (!rows.length) html += `<tr><td colspan="10" class="l muted">${(state.rankRows || []).length ? 'No accounts match the filter.' : 'No entries yet — use the Update tab.'}</td></tr>`;
  rows.forEach((r, i) => {
    const vClass = r.variance >= 0 ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
    html += `<tr><td class="l">${i + 1}</td><td class="l">${esc(r.name)}</td><td class="l">${esc(r.wing) || '—'}</td><td>${inrUsd(r.revenue)}</td>${costCell(r.totalCost)}<td>${inrUsd(r.grossProfit)}</td><td>${pct(r.gm)}</td><td>${pct(r.budgetGM)}</td><td ${vClass}>${(r.variance * 100).toFixed(1)}%</td><td>${statusPill(r.status)}</td></tr>`;
  });
  $('#rankTable').innerHTML = html + '</tbody>';
}

// ================= TOOLS (table + cumulative panel) =================
$('#addToolBtn').addEventListener('click', () => editTool(null));

function toolMonthlyInr(t) {
  const cost = Number(t.cost) || 0;
  return t.currency === 'INR' ? cost : cost * fxRate();
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
      <td class="l">${esc(t.department || 'General')}</td>
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

  // per-department monthly (active only)
  const byDept = {};
  activeTools.forEach((t) => { const d = t.department || 'General'; byDept[d] = (byDept[d] || 0) + toolMonthlyInr(t); });
  const deptRows = Object.entries(byDept).sort((a, b) => b[1] - a[1])
    .map(([d, v]) => `<div class="prow"><span>${esc(d)}</span><span class="val">${inr(v)}</span></div>`).join('');

  const stat = (label, val, sub) => `<div class="cum-stat"><div class="label">${label}</div><div class="value">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('#toolsCumulative').innerHTML = `
    <h3>Spend summary</h3>
    ${stat('Active tools', activeTools.length, stoppedTools.length ? stoppedTools.length + ' stopped' : '')}
    ${stat('Monthly recurring', inr(monthlyActive), '≈ ' + usd(monthlyActive))}
    ${stat('Spent to date', inr(spentAll), 'since ' + since)}
    ${stat('Annualised', inr(monthlyActive * 12), '≈ ' + usd(monthlyActive * 12))}
    ${deptRows ? `<h3 style="margin-top:16px">Monthly by department</h3><div class="cum-list">${deptRows}</div>` : ''}
    <p class="muted small" style="margin-top:12px">Spend to date = monthly cost × months since start (until stop date for stopped tools). Stopped tools keep their history.</p>`;
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
  const depts = [...(state.boot.wings || []), 'General', 'All departments'];
  const curDept = t ? t.department : 'General';
  const deptOpts = [...new Set([curDept, ...depts])].map((d) => `<option value="${esc(d)}" ${t && t.department === d ? 'selected' : ''}>${esc(d)}</option>`).join('');
  const body = el('div');
  body.innerHTML = `
    <label class="field"><span>Tool name</span><input id="t_name" value="${t ? esc(t.name) : ''}" placeholder="e.g. Ahrefs" /></label>
    <label class="field"><span>What is it?</span><textarea id="t_desc" rows="2" placeholder="Short description">${t ? esc(t.description) : ''}</textarea></label>
    <div class="field-row">
      <label class="field"><span>Cost / month</span><input id="t_cost" type="number" min="0" step="0.01" value="${t ? (t.cost || 0) : ''}" placeholder="0" /></label>
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
    <label class="field"><span>Department</span><select id="t_dept">${deptOpts}</select></label>
    <label class="field"><span>Why is it needed?</span><textarea id="t_why" rows="2" placeholder="Reason / use case">${t ? esc(t.why) : ''}</textarea></label>`;
  openModal(id ? 'Edit tool' : 'New tool', body, async () => {
    const name = $('#t_name').value.trim();
    if (!name) { toast('Tool name required'); return false; }
    const payload = {
      name,
      description: $('#t_desc').value,
      cost: Number($('#t_cost').value) || 0,
      currency: $('#t_cur').value,
      department: $('#t_dept').value,
      why: $('#t_why').value,
      startDate: $('#t_start').value,
      stopDate: $('#t_stop').value,
    };
    if (id) await api('/tools/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/tools', { method: 'POST', body: JSON.stringify(payload) });
    state.boot.tools = await api('/tools');
    renderTools();
    toast('Saved');
    return true;
  });
}

async function deleteTool(id) {
  const t = (state.boot.tools || []).find((x) => x.id === id);
  if (!confirm(`Delete “${t ? t.name : 'this tool'}”?`)) return;
  await api('/tools/' + id, { method: 'DELETE' });
  state.boot.tools = await api('/tools');
  renderTools();
  toast('Deleted');
}

// ================= ACCOUNTS (active / inactive) =================
function renderAccounts() {
  const accts = state.boot.accounts;
  const ro = !!state.roleInfo.readOnly;
  const head = ['Account', 'Wing', 'Status', ...(ro ? [] : [''])];
  let html = '<thead><tr>' + head.map((h, i) => `<th class="${i < 2 ? 'l' : ''}">${h}</th>`).join('') + '</tr></thead><tbody>';
  if (!accts.length) html += `<tr><td colspan="${ro ? 3 : 4}" class="l muted">No accounts in your wing yet.</td></tr>`;
  accts.forEach((a) => {
    const on = a.active !== false;
    const statusCell = ro
      ? `<td>${on ? '● Active' : '○ Inactive'}</td>`
      : `<td><button class="btn btn-sm status-toggle ${on ? 'st-on' : 'st-off'}" data-id="${a.id}">${on ? '● Active' : '○ Inactive'}</button></td>`;
    html += `<tr data-id="${a.id}" class="${on ? '' : 'acct-off'}">
      <td class="l">${esc(a.name)}</td>
      <td class="l">${esc(a.wing) || '—'}</td>
      ${statusCell}
      ${ro ? '' : `<td><button class="btn btn-sm edit-acct" data-id="${a.id}">Edit</button></td>`}
    </tr>`;
  });
  $('#accountsTable').innerHTML = html + '</tbody>';
  $$('.edit-acct').forEach((b) => (b.onclick = () => editAccount(Number(b.dataset.id))));
  $$('.status-toggle').forEach((b) => (b.onclick = () => toggleAccountActive(Number(b.dataset.id))));
  $('#addAccountBtn').classList.toggle('hidden', ro || !state.roleInfo.canCreateAccounts);
}

async function toggleAccountActive(id) {
  const a = state.boot.accounts.find((x) => x.id === id);
  if (!a) return;
  const next = !(a.active !== false);
  await api('/accounts/' + id, { method: 'PUT', body: JSON.stringify({ active: next }) });
  a.active = next;
  renderAccounts();
  toast(next ? 'Client set active' : 'Client set inactive');
}

$('#addAccountBtn').addEventListener('click', () => editAccount(null));

function editAccount(id) {
  const acct = id ? state.boot.accounts.find((a) => a.id === id) : null;
  const wings = state.roleInfo.wings === '*' ? state.boot.wings : state.roleInfo.wings;
  const body = el('div');
  body.innerHTML = `
    <label class="field"><span>Client name</span><input id="m_name" value="${acct ? esc(acct.name) : ''}" /></label>
    <label class="field"><span>Wing / department</span>
      <select id="m_wing">${wings.map((w) => `<option value="${esc(w)}" ${acct && acct.wing === w ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>
    </label>
    <label class="field checkbox"><input id="m_active" type="checkbox" ${!acct || acct.active !== false ? 'checked' : ''} /> <span>Active client</span></label>`;
  openModal(id ? 'Edit client' : 'New client', body, async () => {
    const name = $('#m_name').value.trim();
    if (!name) { toast('Name required'); return false; }
    const payload = { name, wing: $('#m_wing').value, active: $('#m_active').checked };
    if (id) await api('/accounts/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/accounts', { method: 'POST', body: JSON.stringify(payload) });
    state.boot = await api('/bootstrap');
    renderAccounts();
    toast('Saved');
    return true;
  });
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
  af.innerHTML =
    fld('a_srRate', 'Sr rate (₹/hr)', a.srRate) +
    fld('a_jrRate', 'Jr rate (₹/hr)', a.jrRate) +
    fld('a_srCap', 'Sr capacity (hrs/mo)', a.srCapacity) +
    fld('a_jrCap', 'Jr capacity (hrs/mo)', a.jrCapacity) +
    fld('a_resCap', 'Hours per resource / month', a.resourceMonthlyHours || 180) +
    fld('a_cont', 'Contingency %', Math.round(a.contingency * 100)) +
    fld('a_min', 'GM min % (At Risk below)', Math.round(a.gmMin * 100)) +
    fld('a_healthy', 'GM healthy % (✅ at/above)', Math.round(a.gmHealthy * 100));
  $('#saveAssumptions').onclick = async () => {
    await api('/settings/assumptions', { method: 'PUT', body: JSON.stringify({
      srRate: +$('#a_srRate').value, jrRate: +$('#a_jrRate').value,
      srCapacity: +$('#a_srCap').value, jrCapacity: +$('#a_jrCap').value,
      resourceMonthlyHours: +$('#a_resCap').value || 180,
      contingency: (+$('#a_cont').value) / 100, gmMin: (+$('#a_min').value) / 100, gmHealthy: (+$('#a_healthy').value) / 100,
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
}

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
