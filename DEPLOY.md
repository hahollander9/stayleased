# Putting the StayLeased demo on the web

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
