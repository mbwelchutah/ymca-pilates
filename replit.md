# YMCA Pilates Registration — Project Notes

Node.js app that automates registration for the Wednesday 7:45 AM Core Pilates class (Stephanie Sanders) at the Eugene YMCA via the Daxko / familyworks booking system.

## Architecture

- **`src/web/server.js`** — HTTP server on port 5000. Serves the web UI and three API routes (`/register`, `/run-job`, `/status`). Jobs run in the background; the browser polls `/status` every 2 seconds so the UI never freezes.
- **`src/bot/register-pilates.js`** — Playwright booking bot. Exported as `runBookingJob(job)`. Accepts `maxAttempts` in the job object (defaults to 20; web UI passes 1). Uses the system Chromium binary (detected via `which chromium`) to avoid shared-library issues with the bundled Playwright browser.
- **`src/bot/run-from-db.js`** — Loads job id=1 from the database and calls `runBookingJob`.
- **`src/db/init.js`** — Opens / creates `data/app.db` (SQLite via better-sqlite3). On first run with an empty DB, seeds jobs from `data/seed-jobs.json` so production always starts with the correct class list.
- **`src/db/jobs.js`** — CRUD: `createJob`, `getAllJobs`, `getJobById`.
- **`src/db/create-test-job.js`** — Creates a fake test job whose booking window opens in ~15 min.
- **`src/db/cleanup-test-jobs.js`** — Deletes Core Pilates test jobs older than 24h.
- **`src/scheduler/booking-window.js`** — Calculates the next booking-open time (3 days before class, 1 hour before class start, Pacific timezone). Returns phase: `too_early` / `warmup` / `sniper` / `late`.
- **`src/scheduler/run-scheduler-once.js`** — Checks phase for all active DB jobs, runs bot if phase is sniper/late. Runs once and exits (no persistent loop).
- **`src/scheduler/run-eligible-jobs-once.js`** — Alias for the above.
- **`src/scheduler/test-booking-window.js`** — Smoke test: prints parsed class time, next class date, booking open date, and current phase.

## Tech stack

- Node.js 20, CommonJS
- Playwright (Chromium — system binary, not bundled)
- better-sqlite3
- Native `http` module (no Express)

## Key design decisions

- **Background job + polling**: clicking a button returns immediately with `{ started: true }`. The bot runs in the background. `/status` returns `{ active, log, success }` and the browser polls it every 2s.
- **Single-attempt from web UI**: `maxAttempts: 1` is passed from the web server so a manual button press doesn't block for 10 minutes. The 20-attempt retry loop is preserved for cron/CLI use.
- **FW-first OAuth auth**: `createSession()` does NOT pre-login to Daxko directly. Instead it navigates to the FW schedule embed first (publicly accessible). When the booking modal shows "Login to Register" and is clicked, Daxko sees no existing session and redirects to `find_account?oauth_state=...` for a proper OAuth flow. After credentials are filled, Daxko redirects back to FW `/y_login?code=...` and the FW session cookie is set. Pre-logging into Daxko first breaks this flow because Daxko then skips the OAuth redirect and goes to `MyAccountV2.mvc` instead.
- **Fast-fail on "Login to Register"**: if the session expired and the page shows that button, the bot exits immediately with a clear error instead of retrying.
- **Graceful SIGTERM shutdown**: the server handles SIGTERM (sent by Replit on restart) by calling `server.close()` to release port 5000, with a 4-second hard-exit fallback. The start script also kills any stale `node src/web/server.js` processes before launching.

## Environment secrets

- `YMCA_EMAIL` — YMCA account email (stored in Replit Secrets)
- `YMCA_PASSWORD` — YMCA account password (stored in Replit Secrets)

## npm scripts

```
npm start                      Start web server (kills stale instance first)
npm run bot                    Run booking bot from CLI
npm run bot:db                 Run bot using DB job
npm run db:test                Seed default job (id=1)
npm run db:create-test-job     Create test job, booking window opens in ~15 min
npm run db:cleanup-test-jobs   Delete Core Pilates test jobs older than 24h
npm run scheduler:test         Print booking window info for job #1
npm run scheduler:once         Check phases, run bot if eligible (exits after one pass)
npm run scheduler:run          Same as scheduler:once
```

## Git Workflow (Simple)

The Replit Git panel and terminal Git commands do exactly the same thing — use whichever feels easier.

**Option A — Replit UI (recommended for beginners):**
1. Make your changes
2. Open the Git tab (branch icon in the left sidebar)
3. Click "Stage and commit" — write a short description of your change
4. Click "Push"

**Option B — Terminal:**
```bash
git add .
git commit -m "describe your change"
git push
```

**How to verify your push worked:**
Open your GitHub repo and check the latest commit — it should match the message you just wrote. If it does not, you probably forgot to push.

**Always confirm you are on `main` before pushing:**
```bash
git branch --show-current
```
If it prints something other than `main`, switch back with `git checkout main`. Pushing from a different branch will not update `main`.

## Current limitations

- No persistent scheduler loop — must be triggered manually or via GitHub Actions cron
- Web UI is minimal — no job management, only run triggers and status
- Scheduler does not yet have a continuous watch mode
