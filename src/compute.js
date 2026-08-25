// Faithful re-implementation of the JW BNGM spreadsheet GM engine.
//
// Per account, per month:
//   manpower    = srHrs*srRate + midHrs*midRate + jrHrs*jrRate
//                 (three employee categories — Senior / Middle / Junior, user 2026-08-21)
//   outsourcing = sum of outsourcing line costs
//   toolShare   = (accountRevenue / totalRevenueThatMonth) * toolPool[month]
//   totalCost   = manpower + outsourcing + toolShare
//   (contingency was removed from the model — user, 2026-08-21)
//   grossProfit = revenue - totalCost
//   gm%         = revenue ? grossProfit / revenue : 0
//
// "revenue" defaults to Actual; falls back to Planned when Actual is 0 (mirrors how
// the sheet is used month-to-month before actuals land). Both are surfaced so the UI
// can show budget-vs-actual variance.

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function entryRevenue(entry, mode) {
  const actual = num(entry.revActual);
  const planned = num(entry.revPlanned);
  if (mode === 'planned') return planned;
  if (mode === 'actual') return actual;
  // auto: prefer actual, else planned
  return actual || planned;
}

function entryHours(entry, mode) {
  if (mode === 'planned') {
    return { sr: num(entry.srHrsPlan), mid: num(entry.midHrsPlan), jr: num(entry.jrHrsPlan) };
  }
  return { sr: num(entry.srHrs), mid: num(entry.midHrs), jr: num(entry.jrHrs) };
}

// Per-category ₹/hr rates, tolerant of the pre-3-tier assumptions shape
// (midRate falls back to the average of the senior & junior rates).
function rates(a) {
  const sr = num(a.srRate);
  const jr = num(a.jrRate);
  const mid = a.midRate != null ? num(a.midRate) : Math.round((sr + jr) / 2);
  return { sr, mid, jr };
}

// Outsourcing is now split Plan vs Actual (user, 2026-08-24), like revenue & hours.
// Legacy entries carry a single `outsourcing` array — fall back to it when the
// mode-specific field isn't present so old data still costs correctly.
function outsourcingArr(entry, mode) {
  const plan = Array.isArray(entry.outsourcingPlan) ? entry.outsourcingPlan : null;
  const act = Array.isArray(entry.outsourcingActual) ? entry.outsourcingActual : null;
  const legacy = Array.isArray(entry.outsourcing) ? entry.outsourcing : [];
  if (mode === 'planned') return plan || legacy;
  if (mode === 'actual') return act || legacy;
  // auto: prefer actual figures, else planned, else legacy
  if (act && act.length) return act;
  if (plan && plan.length) return plan;
  return act || plan || legacy;
}

function outsourcingTotal(entry, mode = 'auto') {
  return outsourcingArr(entry, mode).reduce((s, o) => s + num(o.cost), 0);
}

function statusOf(gm, hasRevenue, a) {
  if (!hasRevenue) return 'none';
  if (gm >= a.gmHealthy) return 'healthy';
  if (gm >= a.gmMin) return 'review';
  return 'atrisk';
}

// Compute one account+month costing.
// totalMonthRevenue is the sum across ALL accounts for that month (for tool apportioning).
function computeEntry(entry, opts) {
  const { assumptions: a, toolPoolForMonth = 0, totalMonthRevenue = 0, mode = 'auto' } = opts;
  const revenue = entryRevenue(entry, mode);
  const { sr, mid, jr } = entryHours(entry, mode);
  const r = rates(a);
  const manpower = sr * r.sr + mid * r.mid + jr * r.jr;
  const outsourcing = outsourcingTotal(entry, mode);
  const toolShare =
    totalMonthRevenue > 0 ? (revenue / totalMonthRevenue) * num(toolPoolForMonth) : 0;
  const totalCost = manpower + outsourcing + toolShare;
  const grossProfit = revenue - totalCost;
  const gm = revenue > 0 ? grossProfit / revenue : 0;
  return {
    revenue,
    srHrs: sr,
    midHrs: mid,
    jrHrs: jr,
    manpower,
    outsourcing,
    toolShare,
    totalCost,
    grossProfit,
    gm,
    status: statusOf(gm, revenue > 0, a),
  };
}

// Sum of revenue across all entries for a given month (for tool apportioning).
function monthRevenueTotals(entries, mode) {
  const totals = {};
  for (const e of entries) {
    totals[e.month] = (totals[e.month] || 0) + entryRevenue(e, mode);
  }
  return totals;
}

module.exports = {
  num,
  rates,
  computeEntry,
  monthRevenueTotals,
  entryRevenue,
  outsourcingTotal,
  outsourcingArr,
  statusOf,
};
