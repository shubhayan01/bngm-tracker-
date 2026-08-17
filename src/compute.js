// Faithful re-implementation of the JW BNGM spreadsheet GM engine.
//
// Per account, per month:
//   manpower    = srHrs * srRate + jrHrs * jrRate
//   outsourcing = sum of outsourcing line costs
//   toolShare   = (accountRevenue / totalRevenueThatMonth) * toolPool[month]
//   contingency = revenue * contingencyPct
//   totalCost   = manpower + outsourcing + toolShare + contingency
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
    return { sr: num(entry.srHrsPlan), jr: num(entry.jrHrsPlan) };
  }
  return { sr: num(entry.srHrs), jr: num(entry.jrHrs) };
}

function outsourcingTotal(entry) {
  if (!Array.isArray(entry.outsourcing)) return 0;
  return entry.outsourcing.reduce((s, o) => s + num(o.cost), 0);
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
  const { sr, jr } = entryHours(entry, mode);
  const manpower = sr * num(a.srRate) + jr * num(a.jrRate);
  const outsourcing = outsourcingTotal(entry);
  const toolShare =
    totalMonthRevenue > 0 ? (revenue / totalMonthRevenue) * num(toolPoolForMonth) : 0;
  const contingency = revenue * num(a.contingency);
  const totalCost = manpower + outsourcing + toolShare + contingency;
  const grossProfit = revenue - totalCost;
  const gm = revenue > 0 ? grossProfit / revenue : 0;
  return {
    revenue,
    srHrs: sr,
    jrHrs: jr,
    manpower,
    outsourcing,
    toolShare,
    contingency,
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
  computeEntry,
  monthRevenueTotals,
  entryRevenue,
  outsourcingTotal,
  statusOf,
};
