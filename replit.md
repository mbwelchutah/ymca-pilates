# YMCA BOT — Project Notes

Automates YMCA pilates/yoga class registration via Playwright + Daxko/FamilyWorks OAuth. Built as a full-stack PWA: Node.js API backend + React/TypeScript/Tailwind frontend.

## Architecture

### Backend (`src/`)

| File | Purpose |
|------|---------|
| `src/web/server.js` | HTTP server. Port 5001 (dev) / 5000 (prod). Serves static build + 50+ API routes. No Express — native `http` module. |
| `src/bot/register-pilates.js` | Playwright booking bot. 19-step sequence: FW session → class card → modal → auth → register. |
| `src/bot/confirmed-ready.js` | Canonical "confirmed-ready" model. Aggregates auth freshness + classTruth freshness + preflight freshness into a single `{status, auth, classTruth, preflight, overall}` state. Written to `src/data/confirmed-ready-state.json`. |
| `src/bot/readiness-state.js` | Persists normalized readiness snapshot to `src/data/readiness-state.json`. Fields: session, schedule, discovery, modal, action, confidenceScore, classTruthFreshness. |
| `src/bot/confidence.js` | Server-side confidence scorer. 0–100 score from session/schedule/discovery/modal/action signals. |
| `src/bot/session-check.js` | Verifies Daxko + FamilyWorks sessions via HTTP ping (no browser). |
| `src/bot/sniper-readiness.js` | Persists sniper-state bundle for UI display. |
| `src/bot/auth-state.js` | Auth-in-progress lock + startup session validation. |
| `src/classifier/classTruth.js` | Synchronous schedule-cache classifier. Returns `{state, openSpots, freshness, source, confidence}` without launching Playwright. |
| `src/classifier/scheduleCache.js` | In-memory + on-disk schedule cache. `computeCacheFreshness()` returns 'fresh'/'aging'/'stale'/'unknown'. `isCacheAdequate()` guards the HTTP-ping fast path. |
| `src/scheduler/tick.js` | One scheduler tick: load active jobs → phase/cooldown/classifier/auth gates → `runBookingJob` → `refreshConfirmedReadyState`. |
| `src/scheduler/preflight-loop.js` | Background preflight runner. Periodic lightweight session + schedule checks. Calls `refreshConfirmedReadyState` on every outcome. |
| `src/scheduler/auto-preflight.js` | HTTP-ping fast path for auto-preflight (no browser). Falls back to Playwright when `isCacheAdequate()` returns false. |
| `src/scheduler/booking-window.js` | Phase calculator: `too_early` / `warmup` / `sniper` / `late`. |
| `src/scheduler/execution-timing.js` | Computes opensAt / warmupAt / armedAt with per-job learned offsets. |
| `src/scheduler/timing-learner.js` | Learns per-job timing offsets from historical booking data. |
| `src/scheduler/escalation.js` | Escalation records for persistent click failures. |
| `src/db/jobs.js` | SQLite CRUD for jobs table (via better-sqlite3). |
| `src/db/pg-init.js` | PostgreSQL sync: restores jobs from PostgreSQL → `data/seed-jobs.json` on startup. |

### Frontend (`client/src/`)

| File | Purpose |
|------|---------|
| `screens/NowScreen.tsx` | Main view (~3000 lines). Class card, readiness confidence, armed checklist, exec steps, trust line, classifier availability row. |
| `screens/PlanScreen.tsx` | Job list with availability badges and sniper status. |
| `screens/ToolsScreen.tsx` | Manual controls: run scheduler, preflight, session check. |
| `screens/SettingsScreen.tsx` | App settings, auth management. |
| `lib/classTruth.ts` | TypeScript types for `ClassTruthResult` including `freshness` and `source` fields. |
| `lib/api.ts` | All API methods. Includes `getReadiness`, `getConfirmedReady`, `classifyJob`. `getReadiness` returns `classTruthFreshness` for trust-line display. |
| `lib/confidence.ts` | Client-side confidence score mirror (0–100 fallback when server hasn't computed yet). |
| `lib/readinessResolver.ts` | Derives `CompositeReadiness` from session + schedule + discovery + modal signals. |
| `lib/sniperArmed.ts` | Computes armed model from readiness + booking state. |
| `lib/bookingCycle.ts` | Determines whether current UTC week is "this week". |
| `lib/countdown.ts` | Live countdown hook for booking window timer. |

## Data Flow

```
Playwright run
  → scheduleCache (intercepted API response) → classTruth classifier
  → sniper-readiness bundle → readiness-state (normalized) → /api/readiness
  → confirmed-ready state → /api/confirmed-ready

preflight-loop / tick.js
  → refreshConfirmedReadyState() after every run outcome

NowScreen (polling /api/readiness every 1–30s)
  → bgReadiness: session, schedule, discovery, modal, action, confidenceScore
  → bgReadiness.classTruthFreshness → stale-cache warning / trust line
  → bgReadiness.lastCheckedAt → "checked N min ago" trust line

classifyJob (/api/jobs/:id/classify)
  → ClassTruthResult: state, openSpots, freshness, source
  → Classifier availability row with inline freshness note
```

## Freshness + Confirmed-Ready Unification (Stages 1–10)

The "Freshness + Confirmed-Ready Unification" feature (fully complete) ensures the UI always reflects whether cached data is trustworthy:

- **Freshness buckets**: `fresh` (<30 min), `aging` (<4 h), `stale` (≥4 h), `unknown`
- **`isCacheAdequate()`**: stale cache forces full Playwright run instead of HTTP-ping fast path
- **`confirmed-ready-state.json`**: aggregates auth + classTruth + preflight freshness into one canonical state
- **`classTruthFreshness`** in `/api/readiness`: piggybacked onto readiness bundle so NowScreen can show stale warnings without a separate API call
- **UI**: classifier row inline freshness note (Stage 6) + trust line "checked N min ago" (Stage 9) + stale-cache fallback warning when classifier has no match (Stage 10)

## Key Design Decisions

- **FW-first OAuth**: MUST NOT pre-login to Daxko before clicking "Login to Register" on the FW schedule embed. Pre-logging breaks the OAuth redirect and lands on `MyAccountV2.mvc` instead of `y_login?code=…`. All session creation goes through `createSession()` in `register-pilates.js`.
- **Confidence threshold**: `CONFIDENCE_THRESHOLD = 8` in `register-pilates.js`. `classifyClass` is synchronous (no Playwright).
- **Burst check**: in-memory only, resets on server restart.
- **Adaptive polling**: NowScreen polls `/api/readiness` every 1 s during armed/warmup/sniper/confirming, 30 s otherwise.
- **Circular dependency guard**: `readiness-state.js` lazy-requires `confirmed-ready.js` inside `computeReadiness()` (not top-level) to avoid the `confirmed-ready ↔ readiness-state` initialisation race.
- **Label hysteresis**: confidence label only downgrades when score falls below a grace-zone floor (High→Medium requires <75, Medium→Low requires <55) to prevent UI oscillation.
- **State hysteresis**: NowScreen top-level card state only transitions when `isTransitionAllowed()` permits, preventing flicker from transient signals.

## Environment

- `YMCA_EMAIL` — YMCA account email (Replit Secret)
- `YMCA_PASSWORD` — YMCA account password (Replit Secret)
- `DATABASE_URL` — PostgreSQL connection string (Replit PostgreSQL add-on)
- SQLite at `data/app.db` (runtime); PostgreSQL used for persistence across restarts via `pg-init.js`
- Backend PORT: 5001 (dev) — Vite proxies API calls; 5000 (prod)
- Chromium: system binary (`which chromium`), not Playwright-bundled, to avoid shared-library conflicts

## npm scripts

```
npm start                      Start API (port 5001) + Vite dev server (port 5000)
npm run bot                    Run booking bot from CLI
npm run bot:db                 Run bot using DB job
npm run db:create-test-job     Create test job opening in ~15 min
npm run db:cleanup-test-jobs   Delete Core Pilates test jobs older than 24h
npm run scheduler:test         Print booking window info for job #1
npm run scheduler:once         Check phases, run bot if eligible (exits)
```
