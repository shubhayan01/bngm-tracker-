# JW BNGM Tracker

A simplified, conversational replacement for the 12-tab **JW BNGM (Budget & Gross-Margin) Tracker** spreadsheet. Instead of 111 columns, a friendly bot asks a few questions per account/month and does all the cost & margin maths for you. Multi-user, role-based login.

## Quick start

Requires a **MySQL / MariaDB** database (local for dev, Hostinger's MySQL in production).

```bash
npm install        # first time only
cp .env.example .env   # then edit: DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME + JWT_SECRET
npm run db:test    # confirm the database connection works
npm run seed       # loads accounts/associates from the workbook + creates logins (first time only)
npm start          # → http://localhost:3000
```

Open **http://localhost:3000** in a browser.

### Default logins (change them in Assumptions after first sign-in)

| Access level                                | Role     | Password      |
| ------------------------------------------- | -------- | ------------- |
| Super Admin (everything)                    | super    | `super123`    |
| Admin (all dept reports except Content, read-only) | admin | `admin123` |
| Business Development                        | bizdev   | `bizdev123`   |
| SEO                                         | seo      | `seo123`      |
| Content                                     | content  | `content123`  |
| Social Media                                | social   | `social123`   |
| Web Development                             | webdev   | `webdev123`   |
| Performance Marketing                       | perfmkt  | `perfmkt123`  |

### Three access levels

- **A. Department** (`seo`, `content`, `social`, `webdev`, `perfmkt`, and `bizdev`) — sees and edits **only its own wing(s)**.
- **B. Admin** — **read-only**. Sees the reports of **all departments except Content**. Cannot add or edit clients, entries, tools or settings (the Update tab is hidden).
- **C. Super** — everything, including the Assumptions tab.

## The tabs after login

Most users land on **✏️ Update**, **📊 Reports**, **🧰 Tools**, **🏢 Client List**, and **⚙️ Assumptions** (Super only). The read-only **Admin** role lands on Reports and has no Update tab.

- **Update** — a single-screen form: pick **client → Planned/Actual**, then fill revenue, resources, outsourcing and notes all on one page with a live costing panel. Everything stays editable so mistakes are easy to fix.
- **Reports** — a **Plan vs Actual** comparison (revenue, gross profit, GM with variance per month), the monthly snapshot, a **Compare months** block (tick two or more months to see them side by side), the wing summary, and a filterable **account ranking**. **Costs are shown as negative** (they're expenses).
- **Tools** — a **table** of every tool (cost, start date, active/stopped, spend-to-date) with a **cumulative spend panel** on the right. Tools can be **Stopped** (kept in history) and **Resumed**. Everyone can view; **Super & Business Development** can add/edit/delete.
- **Client List** — each client is simply **Active** or **Inactive**; inactive clients drop out of the Update picker but keep their figures.
- **Assumptions** — **Super only.** Resource rates & GM assumptions, **Team / resources** (add emails, set senior vs junior), the monthly tool pool, the **Outsourcing options** list (the job types offered when adding an outsourcing cost), and role passwords.

## What each role can do

- **Super Admin** — **the only role that sees everything**: all wings & dashboards, the Assumptions tab (rate card / GM targets / tool pool / outsourcing options), the tool catalog, and everyone's passwords.
- **Admin** — **read-only reports for every department except Content.** No Update tab, no create/edit buttons; the server rejects any write it attempts.
- **Business Development** — scoped like a department (no longer sees all wings). It has **no wing of its own by default**, so it sees no clients until Super assigns it wings in `src/auth.js` (`bizdev.wings`). Can manage the shared tool catalog.
- **SEO / Content / Social Media / Web Development / Performance Marketing** — see and edit **only their own wing's** accounts and a dashboard scoped to their wing; they never see another department's clients or numbers. View-only on Tools.

Rates (₹/hr) are **never shown on the Update/entry screen** — it only captures hours. The rate card lives in the Super-only Assumptions tab.

Wing mapping: SEO → `SEO` + `Guest Posting`; Content → `Content Creation`; Social Media → `SMM`; **Web Development → `Web Dev`; Performance Marketing → `Performance Mktg`**. Super sees all wings; **Admin sees all except `Content Creation`**. Edit these in `src/auth.js` (a wildcard role uses `wings: '*'` with an optional `except` list).

## The Update tab (single-screen entry)

Pick a **client**, choose **Planned or Actual**, and fill everything on one page:

- **Revenue (₹)** for the chosen mode.
- **Resources** — **search a team member by email and add them** (the full member list is no longer shown up front). As you type an email, matching people from the roster appear; pick one to add a row, then type their hours. Senior/Junior is backend-only, used just for the ₹/hr rate. Every resource has a **monthly cap of 180 hrs across all clients**, and each row shows how many hours are still free (and how many are already booked on other clients). The box won't let you exceed the cap, and the server rejects any over-allocation. A **⚙ Manage team** button (Super) adds emails and sets who is senior/junior. The 180-hr cap is editable in Assumptions ("Hours per resource / month").
- **Outsourcing** (the job-type options come from the Super-only **Assumptions → Outsourcing options** list), **word count** (content clients only), and **notes**.

### The team roster (`emp details.txt`)

The list of resources people pick from lives in a plain-text file at the project root, **`emp details.txt`** — one person per line as `email@domain | Sr` or `email@domain | Jr`. Team members are identified by their **email**. Add a new hire by adding a line; the app picks up new emails on restart (it only **adds** — it never deletes or overrides live in-app edits). Seniority can also be changed any time in the app via **Assumptions → Manage team**. A fresh `npm run seed` builds the team from this file. (On upgrade, any legacy name-based resources are auto-converted to placeholder `@justwords.co` emails — replace them with the real addresses in `emp details.txt` or Manage team.)

The live costing panel updates as you type, and every field stays editable — re-pick any client/month/mode to load and correct an existing entry. Planned values feed the budget fields and Actual values the actual fields, so Plan-vs-Actual variance works in Reports.

## USD conversion (hidden by default)

Money is shown in **₹**. The USD conversion is hidden until you either **hover** an amount or flip the **`$`** toggle in the top bar (your choice is remembered). The USD → INR rate is fetched live from [frankfurter.app](https://www.frankfurter.app) on load (cached ~6h, click the rate badge to refresh); offline it falls back to a fixed rate — set `USD_INR_FALLBACK` (default 87).

## Tools (table + spend)

Tools are shown as a table with **cost/mo, start date, status and spend-to-date**, plus a side panel totalling **monthly recurring, annualised and spend-to-date since the earliest start**, broken down by department. A tool can carry a **start** and **stop** date and be **Stopped** when not in use (its prior spend is kept) and **Resumed** later.

## Themes

A light/dark glass UI. Toggle with the ☀️/🌙 button (top-right, and on the login card). Your choice is remembered; the default follows your OS setting.

## How the numbers are calculated (from the workbook)

```
Manpower    = Sr hours × ₹1,300 + Jr hours × ₹750     (rates in Assumptions)
Outsourcing = sum of freelance/vendor costs
Tool share  = account revenue ÷ all-accounts revenue that month × monthly tool pool
Contingency = revenue × 5%
Total cost  = Manpower + Outsourcing + Tool share + Contingency
Gross profit= Revenue − Total cost
GM %        = Gross profit ÷ Revenue
Status      = ≥40% ✅ Healthy · 28–40% ⚠️ Review · <28% 🔴 At Risk
```

All rates, capacities, the contingency %, and both GM thresholds are editable by Super in **Assumptions**.

> **Correction vs. the original sheet:** the spreadsheet's contingency formula mistakenly points at the 28% GM-minimum cell instead of the 5% buffer its own Assumptions tab defines, which over-states every account's cost (e.g. Hero FinCorp Apr-26 came to ₹385,800 instead of ₹345,250). This app uses the intended **5%**. If you truly want the old behaviour, set Contingency % to 28 in Assumptions.

## Architecture

- **Backend:** Node + Express (`server.js`), JWT auth (`src/auth.js`), GM engine (`src/compute.js`).
- **Storage:** **MySQL / MariaDB** via `src/db.js` (pure-JS `mysql2`, no native build). Each collection is one JSON row in a `kv_store` table; the store loads into memory at boot and is flushed to MySQL in a transaction on every save. Connection settings come from `.env` (`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`). Run a **single** app process (the store is held in memory and flushed whole).
- **Frontend:** plain HTML/CSS/JS in `public/` (no build step).
- **Seed data:** `seed-data.json`, extracted from `JW BNGM (Budget & GM) Tracker_SMM.xlsx`.

## Deploying to Hostinger (true multi-user)

See **[DEPLOY.md](DEPLOY.md)** for the full step-by-step (VPS + MySQL + PM2 + Nginx + HTTPS).
In short:

1. Use a **Hostinger VPS** (shared/web hosting can't run Node). Create a **MySQL database + user** in hPanel.
2. Get the code on the server, `npm install --omit=dev`, and fill in `.env` (DB creds + a random `JWT_SECRET`).
3. `npm run db:test` → `npm run seed` (once).
4. `pm2 start ecosystem.config.js && pm2 save && pm2 startup` to keep it running.
5. Front it with Nginx and get free HTTPS via certbot. Then **change all default passwords**.

The data lives in MySQL, so back it up with `mysqldump` (or hPanel's database backups).

## Resetting

`npm run reset` **wipes the MySQL data** and reloads seed data + default logins.
**This deletes all entered data — never run it on a live system.**
