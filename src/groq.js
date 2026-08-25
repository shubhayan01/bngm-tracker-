// Groq-powered help bot (user, 2026-08-21).
//
// A small wrapper around Groq's OpenAI-compatible chat-completions API. It answers
// "how do I…" questions about the BNGM Tracker and light reporting questions using
// a system prompt that describes the app plus a compact snapshot of the current
// numbers. The API key comes from the GROQ_API_KEY env var, or from settings
// (Super can paste it under Assumptions → Help bot). No key ⇒ the bot is disabled
// and the UI hides itself gracefully.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Currently-available Groq production model (user, 2026-08-21). `llama-3.1-8b-instant`
// is broadly available across tiers; change it under Assumptions → Help bot if needed.
const DEFAULT_MODEL = 'llama-3.1-8b-instant';

function apiKey(settings) {
  return process.env.GROQ_API_KEY || (settings && settings.groqApiKey) || '';
}
function model(settings) {
  return (settings && settings.groqModel) || process.env.GROQ_MODEL || DEFAULT_MODEL;
}
function isEnabled(settings) {
  return !!apiKey(settings);
}

const APP_GUIDE = `You are the built-in help assistant for the "JW BNGM Tracker" — a web app that
replaces a Budget & Gross-Margin (BNGM) spreadsheet for a digital-marketing agency (JustWords).

What the app does and how it is used:
- "Update" tab: pick a Client, then the Service/Department, then a Year and Month, then choose Plan or Actual.
  Enter Revenue, add Resources (people, by email) with hours, add Outsourcing/freelance costs, and optional Notes.
  A live "costing" panel shows Revenue, Manpower, Outsourcing, Tool share, Gross profit and GM% as you type.
- When filling ACTUAL, the app shows the PLANNED figures for the same client+month as a reference,
  including the resources that were planned and their expected hours, so you enter what really happened.
- "Reports" tab: portfolio KPIs, monthly snapshot, Plan-vs-Actual comparison (pick months to total),
  wing/department summary, and an account ranking by GM%.
- "Tools" tab: SaaS/tools with monthly cost, start date, status and spend-to-date, plus a per-department
  spend/budget summary. Common (shared) tools are Super-Admin only and their cost is split per department.
- "Client List" tab: mark clients Active/Inactive.
- "Assumptions" (Super Admin only): rates per employee category (Senior/Middle/Junior), hours per resource
  per month (default 180), GM thresholds, the monthly tool pool, per-department tool budgets, outsourcing
  options and role passwords.

Costing model (be precise):
- Manpower = Senior hrs × Senior rate + Middle hrs × Middle rate + Junior hrs × Junior rate.
- Tool share = (account revenue / total revenue that month) × the monthly tool pool.
- Total cost = Manpower + Outsourcing + Tool share. (There is NO contingency — it was removed.)
- Gross profit = Revenue − Total cost. GM% = Gross profit / Revenue.
- Status: Healthy at/above the "GM healthy" threshold, Review above "GM min", At Risk below "GM min".
- Every resource has a monthly hour cap (default 180) shared across ALL clients.

Access levels: Super Admin (everything), Admin (read-only reports, all departments except Content),
and department roles (SEO, Content, Social Media, Web Development, Performance Marketing, Business Development)
which see only their own clients.

Answer concisely and practically. Prefer step-by-step instructions ("Go to the Update tab → …").
If a question needs live numbers you were not given, say what report to open. Never invent figures.
Keep answers short unless asked for detail.`;

// snapshot: a compact object the caller passes so the bot can answer light
// reporting questions ({ ytd, assumptions, monthCount, accountCount } etc.).
function buildSystemPrompt(snapshot) {
  let ctx = '';
  if (snapshot && typeof snapshot === 'object') {
    try {
      ctx = '\n\nCurrent snapshot (for reference, may be partial):\n' +
        JSON.stringify(snapshot).slice(0, 3000);
    } catch { /* ignore */ }
  }
  return APP_GUIDE + ctx;
}

// messages: [{ role: 'user'|'assistant', content }]. Returns the assistant reply text.
async function ask(settings, messages, snapshot) {
  const key = apiKey(settings);
  if (!key) throw new Error('Help bot is not configured — add a Groq API key under Assumptions.');
  if (typeof fetch !== 'function') throw new Error('fetch unavailable on this Node runtime');

  const chat = [{ role: 'system', content: buildSystemPrompt(snapshot) }];
  for (const m of Array.isArray(messages) ? messages.slice(-12) : []) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = String((m && m.content) || '').slice(0, 4000);
    if (content) chat.push({ role, content });
  }

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: model(settings),
      messages: chat,
      temperature: 0.2,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('Groq HTTP ' + res.status);
    throw new Error(msg);
  }
  const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return String(reply || '').trim() || '(no answer)';
}

module.exports = { ask, isEnabled, DEFAULT_MODEL };
