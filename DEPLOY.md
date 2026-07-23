# Putting StayLeased on the web

## Working model (real customers, persistent data) — the current production shape

The demo paths below still work, but the live site now supports REAL customer
orgs: invite-code signup at `/signup`, guided onboarding at `/welcome`, and
the Migration Center at `/setup/import`. For customer data to survive
restarts and deploys, the database must live on a persistent disk:

1. Render dashboard → **stayleased** service → **Settings → Instance Type**
   → **Starter** (~$7/mo; the free plan sleeps and cannot mount disks).
2. **Disks → Add Disk**: name `stayleased-data`, mount path `/data`, 1 GB
   (~$0.25/mo).
3. **Environment** → add:
   - `STAYLEASED_DB` = `/data/stayleased.db` (data now lives on the disk)
   - `STAYLEASED_SIGNUP_CODE` = an invite code you choose (enables `/signup`;
     leave unset to keep signups closed)
   - `ANTHROPIC_API_KEY` = a key from console.anthropic.com (flips AI from
     the demo brain to live Claude: lease-PDF reading, import mapping assist,
     agent replies). Optional but recommended.
4. **Manual Deploy → Deploy latest commit.** The FIRST boot on a fresh disk
   seeds the demo org onto it (~2 min before the site answers); after that,
   boots are instant and nothing resets. The Summit Ridge demo org coexists
   with real customer orgs — demo logins keep working.

Live orgs are fenced from the demo machinery: they run on the real calendar
(rent posts on the 1st, late fees per policy), simulator feeds (fake leads,
fake bank transactions, fake meter reads) never run for them, the simulator
console is blocked, and new accounts get one-time random passwords instead of
`demo1234`. Payments/screening/bank rails remain SIMULATED platform-wide and
are labeled as such on `/setup/connections` — do not treat simulated receipts
as real funds.

To rehearse the customer journey: `/signup` (your invite code) → `/welcome`
→ Migration Center → upload a rent roll (or grab its Excel template) →
review mapping → Apply.

---

# Putting the StayLeased demo on the web (original demo paths)

Three paths, easiest first. The app is a single Node 22 process with a SQLite
file — no external database or services to set up. Everything in it is
simulated demo data (passwords `demo1234`), so treat any public deployment as
a **demo sandbox**: anyone with the link can sign in and click around, and a
restart resets the world to the pristine seed.

## Path 0 — run it on your own computer (2 minutes, no account, no domain)

No terminal needed — see **HOW-TO-RUN.txt**:

1. Install the Node.js LTS from nodejs.org (anything 22.11+, current 24 LTS included).
2. Unzip `stayleased-source.zip` and double-click **Start-StayLeased.bat** (Windows) or
   **Start-StayLeased.command** (Mac — right-click → Open the first time).

The zip ships with the one runtime dependency bundled (no npm needed). The
first launch builds the demo world (~1 minute), then opens
**http://localhost:3000** — later launches take seconds. Sign in as
`admin@summitridge.demo` / `demo1234`. Delete the `data` folder to rebuild
the pristine world.

By hand, the same thing is: `npm install` → `npm run seed` → `npm run dev`.

That's the full clickable website, just only visible on your machine.

## Path 1 — free public URL, no domain needed (~15 minutes)

Uses Render's free tier: you get a permanent `https://<name>.onrender.com`
URL. Free instances sleep after ~15 idle minutes and take ~a minute to wake —
fine for a demo. The Dockerfile bakes the seeded world into the image, so
every wake/redeploy starts instantly from the same pristine data.

1. **Put the code on GitHub** (free account at github.com):
   - Create a new repository (private is fine), e.g. `stayleased`.
   - From the unzipped folder:
     ```bash
     git init && git add -A && git commit -m "StayLeased"
     git branch -M main
     git remote add origin https://github.com/<you>/stayleased.git
     git push -u origin main
     ```
2. **Create the service on Render** (free account at render.com, no card
   needed for the free plan):
   - New → **Blueprint** → connect your GitHub → pick the `stayleased` repo.
     Render reads `render.yaml` and sets everything up (Docker, free plan,
     health check). Or: New → Web Service → pick the repo → Language:
     **Docker** → Instance type: **Free**.
   - First build takes a few minutes (it runs the seed inside the build).
3. Open `https://<name>.onrender.com` and log in with the demo accounts.

Railway (railway.app) works the same way from the same Dockerfile if you
prefer it; its trial/hobby plan gives a `*.up.railway.app` URL.

## Path 2 — later, with your own domain

Buy a domain anywhere (~$10–15/yr — Cloudflare, Namecheap, Porkbun), then in
the Render dashboard: Settings → Custom Domains → add `demo.yourdomain.com`
and create the CNAME record it shows you at your registrar. HTTPS is
automatic. Nothing in the app changes.

## Good to know

- **Resetting the world:** redeploy (or just restart) the service — the image
  contains the freshly seeded database. Locally: `npm run seed -- --reset`.
- **Keeping changes instead:** on a paid Render/Railway plan you can attach a
  persistent disk and mount it at `/app/data` so the world survives restarts.
- **Locking it down:** if you don't want strangers clicking around, the
  simplest options are keeping the URL private, or fronting it with
  Cloudflare Access / an access password at the host level.
