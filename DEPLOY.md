# Deploying the JW BNGM Tracker to Hostinger (MySQL)

This app is a **Node.js server** that stores its data in a **MySQL/MariaDB database**.
That means it needs a **Hostinger VPS plan** — the shared/web hosting plans run PHP
only and can't keep a Node process alive.

> **Which Hostinger plan?** A **VPS** (the cheapest KVM plan is plenty for one team).
> You get full root access, install Node + MySQL, and run the app under PM2 behind Nginx.

There are two databases involved conceptually, both on the same VPS:
- **MySQL** — where all the app data lives (accounts, entries, settings, logins).
- Your Node app — talks to MySQL using the `DB_*` values in a `.env` file.

---

## 0. Before you start — change the default passwords

The seed creates logins with obvious defaults (`super123`, `social123`, …). The
**first thing** to do after the app is live is sign in as Super and change every
password in **Assumptions → role passwords**. On the public internet the defaults
are an open door.

---

## 1. Create the MySQL database (in hPanel)

1. hPanel → **Databases → MySQL Databases** (or, on a VPS with a control panel, use phpMyAdmin / the MySQL CLI).
2. Create a **new database** (e.g. `bngm`).
3. Create a **new database user** with a strong password.
4. **Grant that user all privileges** on the `bngm` database.
5. Note the four values: **host**, **database name**, **user**, **password**.
   - On a single VPS the host is usually `localhost` (or `127.0.0.1`), port `3306`.

You don't need to create any tables — the app creates its own on first run.

---

## 2. Get the code onto the VPS

SSH into the VPS, then either clone from Git or upload the folder via SFTP.

```bash
# install Node 18+ (once) — using NodeSource:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# get the code
git clone <your-repo-url> bngm     # or SFTP the folder up
cd bngm
npm install --omit=dev
```

---

## 3. Configure `.env`

```bash
cp .env.example .env
nano .env
```

Fill in the MySQL values from step 1 and a random `JWT_SECRET`:

```
DB_HOST=localhost
DB_PORT=3306
DB_USER=bngm_user
DB_PASSWORD=the-strong-password
DB_NAME=bngm
JWT_SECRET=<paste output of: openssl rand -hex 32>
PORT=3000
```

**Test the connection before going further:**

```bash
npm run db:test
```

You should see `✓ Connected and loaded the store.` (with 0 rows the first time).
If it fails, fix the `DB_*` values and retry — nothing else will work until this passes.

---

## 4. Seed the data (once)

```bash
npm run seed
```

This loads accounts/associates from the workbook data and creates the default
logins **in MySQL**. Run it **only once**. (`npm run reset` wipes and reseeds —
it **deletes all entered data**, so never run it on a live system.)

---

## 5. Run it with PM2 (stays up, restarts on reboot)

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup            # run the command it prints, so it survives reboots
```

Check it's alive:

```bash
pm2 status
pm2 logs bngm --lines 30
curl -I http://127.0.0.1:3000     # should return HTTP 200
```

---

## 6. Put Nginx + HTTPS in front

```bash
sudo apt install -y nginx
sudo cp deploy/nginx-bngm.conf /etc/nginx/sites-available/bngm
# edit the file and set your real domain (server_name)
sudo nano /etc/nginx/sites-available/bngm
sudo ln -s /etc/nginx/sites-available/bngm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Point your domain's DNS **A record** at the VPS IP, then get free HTTPS:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d bngm.yourdomain.com
```

Now open **https://bngm.yourdomain.com**, sign in as Super, and change all passwords.

---

## Updating the app later

```bash
cd bngm
git pull
npm install --omit=dev
pm2 restart bngm
```

The schema migration runs automatically on start, and it **never deletes data**.

---

## Backups

Your data is in MySQL, so back it up with `mysqldump` (or Hostinger's built-in
database backups in hPanel):

```bash
mysqldump -u bngm_user -p bngm > bngm-backup-$(date +%F).sql
```

Restore with:

```bash
mysql -u bngm_user -p bngm < bngm-backup-2026-08-24.sql
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `✖ Could not connect to the MySQL database` | Wrong `DB_*` in `.env`, or MySQL not running. Run `npm run db:test`. |
| `ER_ACCESS_DENIED_ERROR` | User/password wrong, or the user lacks privileges on the database. |
| App up but 502 in browser | PM2 app not running (`pm2 status`) or Nginx `proxy_pass` port ≠ `PORT`. |
| Data looks empty | You haven't run `npm run seed`, or it's pointed at a different database. |

> **Do not run more than one instance** of the app (the PM2 config uses a single
> process on purpose). The store is held in memory and flushed to MySQL on save;
> multiple instances would overwrite each other. One process handles a team easily.
