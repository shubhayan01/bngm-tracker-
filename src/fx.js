// Live USD→INR exchange rate with in-memory caching and an offline fallback.
// Source: frankfurter.app (free, no API key). If the fetch fails we keep the
// last good value, or fall back to FALLBACK so the app always has a number.
const FALLBACK = Number(process.env.USD_INR_FALLBACK) || 87;
const TTL_MS = 6 * 60 * 60 * 1000; // refresh a good rate at most every 6 hours
const RETRY_MS = 5 * 60 * 1000; // after a failed fetch, wait 5 min before retrying

// `at` records the last *attempt* (success or failure), so a network that keeps
// failing is not retried on every request. `live` says whether `rate` is real.
let cache = { rate: FALLBACK, at: 0, live: false };
let inflight = null;

async function fetchRate() {
  // Node 18+ has global fetch. Guard just in case.
  if (typeof fetch !== 'function') return null;
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR', {
    signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
  });
  if (!res.ok) throw new Error('fx http ' + res.status);
  const j = await res.json();
  const rate = j && j.rates && Number(j.rates.INR);
  if (!rate || !Number.isFinite(rate)) throw new Error('fx bad payload');
  return rate;
}

// Returns { rate, live, at, fallback }. Never rejects, and — crucially — never
// blocks the caller once we have any value: it returns the cached number
// immediately and refreshes in the background. This keeps /api/bootstrap fast
// even when the FX service is slow or unreachable (the old code awaited a 6s
// fetch on every request whenever a live rate had never been obtained).
async function getRate(force = false) {
  // A good, live rate is valid for 6h; a failed attempt backs off for 5 min so
  // an unreachable service can't trigger a fetch on every single request.
  const ttl = cache.live ? TTL_MS : RETRY_MS;
  const stale = Date.now() - cache.at >= ttl;

  if ((stale || force) && !inflight) {
    inflight = fetchRate()
      .then((rate) => {
        if (rate) cache = { rate, at: Date.now(), live: true };
        else cache = { ...cache, at: Date.now() }; // record the attempt
      })
      .catch(() => {
        // Keep the last good rate (or fallback) but record the attempt time so
        // we don't hammer a failing endpoint.
        cache = { ...cache, at: Date.now(), live: cache.live && cache.rate !== FALLBACK };
      })
      .finally(() => { inflight = null; });
  }

  // An explicit refresh (force) waits for the in-flight fetch so the caller gets
  // the new number. Every other call returns immediately with whatever we have
  // now (a real rate, the last good one, or the fallback) and lets the
  // background refresh above update the cache for next time.
  if (force && inflight) {
    try { await inflight; } catch { /* never throws anyway */ }
  }
  return { ...cache, fallback: FALLBACK };
}

// Kick off a background fetch (e.g. at server boot) so the cache is warm before
// the first request arrives. Never throws.
function warm() { getRate().catch(() => {}); }

module.exports = { getRate, warm, FALLBACK };
