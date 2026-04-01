# ymca-pilates

Automates registration for the Wednesday 7:45 AM Core Pilates class (Stephanie Sanders) at the Eugene YMCA via the Daxko / familyworks booking system.

---

## What this project is now

This started as a single hardcoded booking script. It now has several cooperating pieces:

- A **Playwright booking bot** that logs into Daxko, finds the class, and clicks Register or Waitlist
- A **SQLite jobs database** that stores which class to book
- A **scheduler / booking-window module** that calculates when registration opens and decides whether to run the bot
- A **simple web UI** (served by Replit) for manually triggering a run or inspecting status
- Optional **GitHub Actions** support (bot can also be triggered on a schedule from GitHub)

---

## Architecture

```
src/
  bot/
    register-pilates.js       Main booking bot — logs in, finds class, clicks Register/Waitlist
    run-from-db.js            Loads job #1 from DB and calls runBookingJob()

  db/
    init.js                   Opens / creates the SQLite database (jobs.db)
    jobs.js                   CRUD helpers: createJob, getAllJobs, getJobById
    test-jobs.js              Seeds a default Core Pilates job (id=1) — legacy helper
    create-test-job.js        Creates a test job whose booking window opens in ~15 min
    cleanup-test-jobs.js      Deletes Core Pilates test jobs older than 24 hours

  scheduler/
    booking-window.js         Calculates when booking opens; returns current phase
                              (too_early / warmup / sniper / late)
    run-scheduler-once.js     Checks phase for all active jobs, runs bot if eligible
    run-eligible-jobs-once.js Same as above
    test-booking-window.js    Smoke test: prints parsed times, next class, booking open time

  web/
    server.js                 HTTP server on port 5000
                              Routes: GET / (UI), /register, /run-job, /status
```

**There is no persistent scheduler loop yet.** The scheduler scripts run once and exit. To run on a recurring schedule you must trigger them externally (cron, GitHub Actions, or manually).

---

## How Replit and GitHub fit together

- **Replit** is the main workspace. The app runs here. Secrets (`YMCA_EMAIL`, `YMCA_PASSWORD`) live in Replit's Secrets panel.
- **GitHub** is source control and backup. Changes do not appear on GitHub until you commit and push them.
- The `main` branch is the source of truth. Ignore stale branches on GitHub unless you intentionally created them.

---

## Git Workflow (Simple)

The Replit Git panel and terminal Git commands do exactly the same thing — use whichever feels easier.

### Option A — Replit UI (recommended for beginners)

1. Make your changes
2. Open the **Git tab** (branch icon in the left sidebar)
3. Click **"Stage and commit"** — write a short description of your change
4. Click **"Push"**

### Option B — Terminal

```bash
git add .
git commit -m "describe your change"
git push
```

### How to verify your push worked

Open your GitHub repo and check the latest commit — it should match the message you just wrote. If it does not, you probably forgot to push.

### Important: always be on `main`

If you are on a different branch (for example, an old Claude-created branch), pushing will **not** update `main`. Confirm your branch before pushing:

```bash
git branch --show-current
```

It should print `main`. If it prints something else, switch back:

```bash
git checkout main
```

---

## Safe test workflow (without booking a real class)

**Step 1 — Create a fake test job** whose booking window opens in ~15 minutes:
```bash
npm run db:create-test-job
```

**Step 2 — Check the scheduler phase** for active jobs:
```bash
npm run scheduler:once
```
You will see the phase (`too_early`, `warmup`, `sniper`, or `late`) and minutes until booking opens.

**Step 3 — Run the bot in dry-run mode** (visible browser, no clicks):
```bash
DRY_RUN=1 HEADLESS=false npm run scheduler:run
```
The browser opens, logs in, and finds the class but stops before clicking Register or Waitlist.

**Step 4 — Clean up** old test jobs when done:
```bash
npm run db:cleanup-test-jobs
```
This only removes Core Pilates jobs older than 24 hours, so the real job (id=1) is safe if recently seeded.

---

## Daily / normal workflow

**Start the web UI:**
```bash
npm start
```
The server starts on port 5000. Open the Replit preview to see the control panel.

**Web UI buttons:**
- **Register Me** — runs the booking bot immediately (1 attempt, returns a result in ~30 seconds)
- **Run Saved Job** — same, but loads the job definition from the database first
- **Clean Test Jobs** — runs the cleanup script from the browser

**Run the bot directly from the command line:**
```bash
node src/bot/register-pilates.js
```

**Dry run (no clicks, visible browser):**
```bash
DRY_RUN=1 HEADLESS=false node src/bot/register-pilates.js
```

**Push your changes to GitHub:**
Use either the Git tab in the Replit sidebar or `git add . && git commit -m "..." && git push` in the terminal — both work.

---

## npm scripts reference

| Script | What it does |
|---|---|
| `npm start` | Start the web server (kills any stale instance first) |
| `npm run bot` | Run the booking bot from CLI |
| `npm run bot:db` | Run bot using job loaded from database |
| `npm run db:test` | Seed the database with a default Core Pilates job (id=1) |
| `npm run db:create-test-job` | Create a test job with booking window opening in ~15 min |
| `npm run db:cleanup-test-jobs` | Delete old Core Pilates test jobs (older than 24h) |
| `npm run scheduler:test` | Print booking window info for job #1 |
| `npm run scheduler:once` | Check phase for all active jobs; run bot if eligible (runs once, then exits) |
| `npm run scheduler:run` | Same as scheduler:once |

---

## Environment variables

| Variable | Description |
|---|---|
| `YMCA_EMAIL` | YMCA account email |
| `YMCA_PASSWORD` | YMCA account password |
| `DRY_RUN=1` | Skip clicking Register/Waitlist — safe for testing |
| `HEADLESS=false` | Show the browser window (only useful locally or in non-headless environments) |

Both secrets are stored in Replit's Secrets panel and are injected automatically at runtime.

---

## Known current limitations

- **No persistent scheduler loop.** There is no background process that watches the clock and triggers the bot automatically. You must run the scheduler manually or wire it to an external trigger (GitHub Actions cron, etc.).
- **The web UI is minimal.** Buttons trigger the bot and show a status message. There is no job management UI — all job editing is done via CLI scripts.
- **Real booking depends on the class being listed.** If the schedule page does not show Core Pilates on the target Wednesday, the bot reports it could not find the class and exits cleanly.
- **Test jobs use computed future times.** The fake job created by `db:create-test-job` has a valid time, but there will be no matching class card on the YMCA site — the bot will log in, fail to find the card, and return an error. That is expected.
- **Session expiry causes fast failure.** If Daxko shows "Login to Register" instead of a Register button, the bot now exits immediately with a clear error rather than retrying for 10 minutes.
