// Live USD→INR exchange rate with in-memory caching and an offline fallback.
// Source: frankfurter.app (free, no API key). If the fetch fails we keep the
// last good value, or fall back to FALLBACK so the app always has a number.
const FALLBACK = Number(process.env.USD_INR_FALLBACK) || 87;
const TTL_MS = 6 * 60 * 60 * 1000; // refresh at most every 6 hours

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

// Returns { rate, live, at, fallback }. Never rejects.
async function getRate(force = false) {
  const fresh = Date.now() - cache.at < TTL_MS && cache.live;
  if (fresh && !force) return { ...cache, fallback: FALLBACK };
  if (!inflight) {
    inflight = fetchRate()
      .then((rate) => {
        if (rate) cache = { rate, at: Date.now(), live: true };
      })
      .catch(() => {
        // keep last good; if we never had one, stay on fallback
        if (!cache.live) cache = { rate: FALLBACK, at: Date.now(), live: false };
      })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return { ...cache, fallback: FALLBACK };
}

module.exports = { getRate, FALLBACK };
