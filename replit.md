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
| `src/classifier/classTruth.js` | Synchronous schedule-cache classifier. Returns `{state, openSpots, freshness, cacheFileFreshness, source, confidence, matchType, …}` without launching Playwright. `freshness` is per-entry (`capturedAt`); `cacheFileFreshness` is file-level (`savedAt`) — always present, diagnostic only. |
| `src/classifier/scheduleCache.js` | In-memory + on-disk schedule cache. Two freshness helpers: `computeCacheFreshness(raw)` (file-level, `savedAt`) and `computeEntryFreshness(entry)` (per-entry, `capturedAt`). `FRESHNESS_THRESHOLDS` exports the bucket ms values for both levels. `isCacheAdequate()` guards the HTTP-ping fast path. |
| `src/scheduler/tick.js` | One scheduler tick: load active jobs → phase/cooldown/classifier/auth gates → `runBookingJob` → `refreshConfirmedReadyState`. |
| `src/scheduler/preflight-loop.js` | Background preflight runner. Periodic lightweight session + schedule checks. Calls `refreshConfirmedReadyState` on every outcome. |
| `src/scheduler/auto-preflight.js` | HTTP-ping fast path for auto-preflight (no browser). Falls back to Playwright when `isCacheAdequate()` returns false. |
| `src/scheduler/booking-window.js` | Phase calculator: `too_early` / `warmup` / `sniper` / `late`. |
| `src/scheduler/execution-timing.js` | Computes opensAt / warmupAt / armedAt with per-job learned offsets. |
| `src/scheduler/timing-learner.js` | Learns per-job timing offsets from historical booking data. |
| `src/scheduler/escalation.js` | Escalation records for persistent click failures. |
| `src/db/jobs.js` | SQLite CRUD for jobs table (via better-sqlite3). `syncSeed()` writes seed-jobs.json only; PG sync is now awaited explicitly by server.js mutation handlers. |
| `src/db/pg-init.js` | PostgreSQL sync: restores jobs from PostgreSQL → `data/seed-jobs.json` on startup (PG → SQLite direction only). |
| `src/db/pg-sync.js` | Bidirectional PG helpers: `initFromPg` (startup restore), `syncJobsToPg` (fire-and-forget, legacy), `syncJobsToPgAsync` (awaitable, used by server.js mutation handlers and production startup sync). Serialised via `_syncChain` promise queue — concurrent mutations wait their turn and always read a fresh SQLite snapshot, preventing the interleaved-DELETE duplicate-row bug. `_doSyncJobsToPgCore` reads from SQLite directly (not seed-jobs.json). |

#### Flow-Yoga-failure pass (Apr 16)
Addresses four intertwined bugs that surfaced when Job #24 (Flow Yoga Fri 12 PM) failed at the 3 PM window with a misleading "Class not found on schedule" banner, a modal YES selector timeout, and a ghost-class disappear-then-return flicker on the Plan tab.
- **Tie-break (A)**: `register-pilates.js:findTargetCard` sort now prefers elements that contain an interactive child (`button/[role=button]/a`) over the leanest-descendant-count wrapper. Previously, two equally-scored rows (e.g. duplicate recurring-class DOM entries, desc=27 vs desc=28) could pick a text-only wrapper, causing the click helper's cursor:pointer fallback to land on a class detail page instead of the signup modal.
- **Click helper (B)**: `attemptClickAndVerify` logs loudly when the matched element has no interactive child, and tags marker-stripped click timeouts (`click_marker_stripped`) distinctly from generic click fallbacks so downstream telemetry/UI can differentiate.
- **Second-best promotion (Apr 17)**: When the matched winner has no interactive child, `attemptClickAndVerify` now promotes the runner-up card (`[data-target-class-second="yes"]`) before falling through to the cursor:pointer hunt, but only after a fresh visibility/box probe to guard against Bubble re-render staleness. The promotion flag (`usedSecondBest`) is bubbled up on every exit (success and all hard-failure returns), and the outer caller suppresses its own second-best fallback when the flag is set — preventing a double-attempt of the same card and the resulting "both candidates wrong time" misclassification.
- **Banner (C)**: `/force-run-job` response now includes structured `status`, `reason`, `phase` fields. `NowScreen.performBooking` uses them to derive the failure banner — replacing the old `msg.includes('class')` broad string match that flipped click/modal/verify failures to "Class not found on schedule". New copy for modal-stage failures: "Couldn't open signup modal".
- **Ghost-class flicker (D)**: `useAppState.refresh` keeps a brief grace period (≤ 8 s, ~1-2 poll cycles) for jobs that disappear from a poll response. If they reappear within that window, the disappearance is treated as a transient server-state race (e.g. pg-sync restore), not a legitimate delete — the card stays visible instead of flickering out and back in.

#### Schedule re-scrape verification (Apr 17)
After repeated false-positive incidents where the bot reported "Registered" for runs that left no actual FamilyWorks reservation, added an authoritative post-click verification path. When `checkBookingConfirmed` returns unconfirmed (no Cancel button, no confirmation text — the FW empty-modal pattern), `verifyViaScheduleRescrape` (`register-pilates.js` ~2362) closes the modal, re-finds the same target card via `findTargetCard`, re-clicks it, and inspects the dialog-scoped buttons:
- "View Reservation" / "Unregister" / "Cancel Registration" / "Leave Waitlist" → `verified:true` (definitive registered)
- "Register" / "Waitlist" / "Join Waitlist" → `verified:false` (definitive NOT registered, recorded as `click_silent_no_op`)
- empty / other → `verified:null` (truly ambiguous, falls through to existing retry path)

Hardened against false-positives via four guards: dialog-detach check before re-click (refuses to read stale state if Escape didn't close the modal); explicit re-opened dialog wait; full identity verification (title + time + optional instructor must all appear in re-opened modal text — refuses to interpret on any mismatch, preventing wrong-card matches); modal-scoped button reads (no page-wide bleed-through). Wired into all three click failure branches: Register, Waitlist, and Register-on-full-class waitlist. Architect-approved.

**First production run revealed the actual root cause** of Flow Yoga failures: clicking "Register" navigates to a class detail page (`/m?p=schedules-class&class=...`) instead of reserving. The empty-modal symptoms were the modal closing as the page navigated away. The rescrape helper's URL guard correctly detected the navigation and bailed `not_on_schedule_page` rather than falsely confirming.

#### Apr 17 PM session — Flow Yoga 3 PM root-cause confirmation
A second look at the production logs (the IMG_1490–1492 batch) reframed the detail-page navigation as a *consequence* of an upstream tie-break misfire, not a primary bug:
- The findTargetCard scorer can return two equally-scored rows; without a clickable-child preference the lower-`desc` (leaner inner text wrapper) wins, then the click helper's `cursor:pointer` fallback dispatches on a non-interactive child that happens to be a "view details" link → page navigates off the schedule embed → modal closes empty.
- All four bug fixes from the diagnosis (A tie-break, B click-helper guard, C banner mode, D ghost-class flicker) were *already* in the codebase from earlier April commits (`bcc7c4f2`, `a0f4476`, NowScreen structured `phase`/`reason` banner logic, useAppState `pendingDisappearance` grace). The session validated that the existing fixes cover the failure mode.
- A defensive `completeBookingOnDetailPageIfNavigated` helper sits at `register-pilates.js:2511`.
- **Tie-break diagnostic log (Apr 17 PM)**: `findTargetCard` now records and prints a `[tie-break]` line whenever the top two candidates are equal on score+visibility, showing which axis disambiguated them (`hasClickableChild` flip vs lower-`desc` fallback) and the truncated text of both. Makes it visible in run logs that the Apr 16 fix is firing whenever the duplicate-row condition recurs.

**Apr 17 evening — wrong-class modal hardening (Task #59).** Two cooperating defects produced a Rise & Align Yoga 6:15 AM modal opening for a Flow Yoga 12 PM run:
1. **Size guard in `findTargetCard`'s content locator** (`register-pilates.js` ~1545-1591). The previous `.last()` step on the content locator could bubble up to a page-level wrapper (1280×800) when the schedule embed root contained the title/time/instructor text plus a button somewhere. The locator now iterates candidates deepest→shallowest and rejects any whose bounding box is ≥ viewport width or > 400 px tall, returning the first card-sized match. If none qualify, returns null and lets the caller fall through to the attribute-based path. Logs the rejection so misroutes surface in run logs.
2. **Filter-apply readiness wait** (`register-pilates.js` ~1073-1103). When the schedule "X classes this week" count is 0 or missing at filter-apply time, polls every 150 ms for up to 2 s for the schedule to populate. If still empty, sets a closure-scoped `_scheduleNotLoaded` flag, the helper returns false, and the caller bails with a new distinct reason `schedule_not_loaded` (instead of `filter_apply_failed`) — skipping the noisy unfiltered scan that races a card-render and could click an unrelated promo. The retry loop tries again with a fresh page state. Validated live: log shows `schedule count is 0 — waiting…` → `still 0 after 2s wait — flagging schedule_not_loaded` → run summary `reason: schedule_not_loaded` (not `filter_apply_failed`).

**Apr 17 evening — detail-page handler wired.** The next live run (Job #24, Friday 12 PM Flow Yoga · Hilary, screenshot IMG_1520) advanced through "Class found → Modal reached → Registration action" and then stalled at "Waiting for confirmation". Logs showed the modal opened correctly and the YES click landed; FW then *navigated the page off the schedule embed* to `/m?p=schedules-class&class=...` even though the correct card was clicked. This confirmed detail-page navigation is genuine FW behaviour for this class type, not a wrong-click symptom.

The `completeBookingOnDetailPageIfNavigated` helper is now wired into all three post-click failure branches in `runBookingJob` (Register at line 3157, Waitlist at line 3236, Register-on-full-class at line 3106). The helper runs BEFORE the existing `verifyViaScheduleRescrape` so:
1. If the click stayed on the schedule embed → helper is a no-op, rescrape proceeds as before.
2. If the click navigated to a detail page → helper verifies identity (title + time + instructor), checks for already-registered state, clicks Register/Reserve on the detail page, then navigates back to the schedule embed.
3. The rescrape always runs after — the helper itself never reports success directly. The on-schedule rescrape's modal button inspection ("Cancel Registration" vs "Register") is the authoritative confirmation.

Infinite-loop guard (per architect review): each call site invokes the helper exactly once per attempt. The bounded retry loop already caps total attempts; the helper itself does not loop.

#### Click-attempt speedup (Apr 16, second pass)
Production run showed every attempt was burning ~30 s waiting on the `[data-target-class="yes"]` marker that Bubble had already stripped from the DOM:
- **`DEBUG_HIGHLIGHT` → false** (`register-pilates.js:501`).  Was hardcoded `true`; added a ~2 s `elementHandle()` wait that routinely timed out in production.  Local debug overlay is no longer on the production path.

#### Content-based card locator (Apr 16, third pass)
Replaces the attribute-based return value of `findTargetCard` — which depended on a stamped `data-target-class="yes"` attribute that Bubble strips on every re-render — with an **attribute-independent content locator** that Playwright re-resolves on every operation.  As long as the DOM still contains the class title + time + instructor signals around a `button / [role=button] / a` descendant, every click / scroll / visibility op works across re-renders.
- Built at the end of `findTargetCard` (`register-pilates.js` ~1485-1514): `page.locator('*').filter(hasText=title).filter(hasText=hh:mm).filter(hasText=instructor).filter({ has: buttonLocator }).last()`.
- `filter({ has: buttonLocator })` excludes inner text-only wrappers — solves the AM tie-break bug from a second angle.
- `.last()` picks the innermost (deepest) matching ancestor — avoids an outer page wrapper.
- The `data-target-class` / `-second` stamps are still written inside the `page.evaluate` (for `_lastSecondCard` attribute-based fallback + diagnostic tooling), but the primary returned locator no longer reads them.
- The fast marker-presence probe added in the second pass is removed as redundant — a content locator that survives re-renders has no marker state to check.

### Frontend (`client/src/`)

| File | Purpose |
|------|---------|
| `screens/NowScreen.tsx` | Main view (~3000 lines). Class card, readiness confidence, armed checklist, exec steps, trust line, classifier availability row. |
| `screens/PlanScreen.tsx` | Job list with availability badges and sniper status. |
| `screens/ToolsScreen.tsx` | Manual controls: run scheduler, preflight, session check. "Repair Tools" panel at bottom: Clear Transient, Resync PG, Reset Job State — each with inline confirmation. |
| `screens/SettingsScreen.tsx` | App settings, auth management. |
| `lib/classTruth.ts` | TypeScript types for `ClassTruthResult` including `freshness` (per-entry), `cacheFileFreshness` (file-level), and `source` fields. |
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
  → ClassTruthResult: state, openSpots, freshness (per-entry), cacheFileFreshness (file-level), source
  → Classifier availability row with inline freshness note (NowScreen, PlanScreen)
```

## Freshness Architecture (Two-Pass, Fully Complete)

### Pass 1 — Freshness + Confirmed-Ready Unification
Ensures the UI always reflects whether cached data is trustworthy:
- **Freshness buckets**: `fresh` (<30 min), `aging` (<4 h), `stale` (≥4 h), `unknown`
- **`isCacheAdequate()`**: stale cache forces full Playwright run instead of HTTP-ping fast path
- **`confirmed-ready-state.json`**: aggregates auth + classTruth + preflight freshness into one canonical state
- **`classTruthFreshness`** in `/api/readiness`: piggybacked onto readiness bundle so NowScreen can show stale warnings without a separate API call
- **UI**: classifier row inline freshness note + trust line "checked N min ago" + stale-cache fallback warning when classifier has no match

### Pass 2 — Per-Entry Schedule-Cache Freshness (Stages 1–9, fully complete)
Fixes the gap where `mergeAndSaveEntries` refreshed `savedAt` (file-level) while keeping old entries, making aged entries appear fresh. Key decisions:

- **Two independent freshness measures** — always present on every `ClassTruthResult`:
  - `freshness` — per-entry, based on `entry.capturedAt` (when that specific class row was observed). Used for all gating decisions.
  - `cacheFileFreshness` — file-level, based on `raw.savedAt` (when the cache file was last written). Diagnostic only — **never used in gating**.
- **Separate threshold constants** in `scheduleCache.js`: `ENTRY_FRESH_MS`/`ENTRY_AGING_MS` (entry-level) and `CACHE_FRESH_MS`/`CACHE_AGING_MS` (file-level). Both currently 30 min / 4 h — independently tunable. Exported as `FRESHNESS_THRESHOLDS`.
- **`computeEntryFreshness(entry)`** — uses `entry.capturedAt`. Backward-compatible: entries without `capturedAt` return `'unknown'`.
- **`classTruthFreshness` recomputed live** in `readiness-state.js` from `cr.classTruth.checkedAt` (epoch ms of `capturedAt`) via `computeFreshness()` — not read from the frozen bucket in the persisted confirmed-ready snapshot.
- **`ConfirmedReadyState.classTruth`** in `api.ts` includes both `freshness` and `cacheFileFreshness`.
- **ToolsScreen** Confirmed Ready card shows a "Cache file" row only when `cacheFileFreshness` diverges from `freshness` — the exact case the pass is designed to surface.
- **Gating invariant**: all four gating decisions (warmup suppression, `needs_attention` full/not-found, `confirmed_ready` gate) use `classTruth.freshness` (per-entry). `cacheFileFreshness` must never be used in a gate.
- **Past-date eviction** (Stage 9): `_isPastDate(dateISO)` helper returns true for any `YYYY-MM-DD` string strictly before today UTC. Applied in two places: (1) `mergeAndSaveEntries` drops past-date entries from `kept` before writing, preventing indefinite accumulation; (2) `findEntry` skips past-date entries in the scoring map so a week-old "full" result can never be returned as the best match for an upcoming booking.

## Repair / Recovery Routes

Three POST endpoints under `/api/recovery/` — all require `{ confirm: true }` in the request body or they return HTTP 400.

| Route | What it does | What it never touches |
|-------|-------------|----------------------|
| `POST /api/recovery/clear-transient` | Deletes files in `TRANSIENT_FILES` + `src/data/replays/`. App regenerates them on next cycle. | SQLite, PostgreSQL, seed-jobs.json, cookies, credentials, timing-learner.json, settings |
| `POST /api/recovery/resync-pg` | Calls `syncJobsToPgAsync()` — copies current SQLite jobs to PostgreSQL. Does not modify job content. | Job data (read-only copy) |
| `POST /api/recovery/reset-job-state` | Calls `clearLastRun(id)` — nulls `last_run_at`, `last_result`, `last_error_message`, `last_success_at` for one job, then syncs to PG. | All other jobs, credentials, settings |

UI: **Repair Tools** section at the bottom of the Tools screen (`ToolsScreen.tsx` → `RecoveryPanel`). Each action has a two-click inline confirmation flow (Request → Confirm/Cancel), loading state, and ✓/✗ result feedback.

## Engineering Reference

See `ENGINEERING_NOTES.md` for the full bug taxonomy, system invariants,
triage workflow, subsystem file map, preferred fix types, audit history,
and current high-risk areas.  Update it after major subsystem passes.

## Key Design Decisions

- **FW-first OAuth**: MUST NOT pre-login to Daxko before clicking "Login to Register" on the FW schedule embed. Pre-logging breaks the OAuth redirect and lands on `MyAccountV2.mvc` instead of `y_login?code=…`. All session creation goes through `createSession()` in `register-pilates.js`.
- **Confidence threshold**: `CONFIDENCE_THRESHOLD = 8` in `register-pilates.js`. `classifyClass` is synchronous (no Playwright).
- **Burst check**: in-memory only, resets on server restart.
- **Adaptive polling**: NowScreen polls `/api/readiness` every 1 s during armed/warmup/sniper/confirming, 30 s otherwise.
- **Circular dependency guard**: `readiness-state.js` lazy-requires `confirmed-ready.js` inside `computeReadiness()` (not top-level) to avoid the `confirmed-ready ↔ readiness-state` initialisation race.
- **Label hysteresis**: confidence label only downgrades when score falls below a grace-zone floor (High→Medium requires <75, Medium→Low requires <55) to prevent UI oscillation.
- **State hysteresis**: NowScreen top-level card state only transitions when `isTransitionAllowed()` permits, preventing flicker from transient signals.
- **Post-click speed (Task #60)**: After Register/Waitlist click, fast-bail in `checkBookingConfirmed` when URL is off `schedulesembed` (skips 3 s delayed-Cancel wait); detail-page helper outcomes `success`/`already_registered` are trusted (no rescrape) and `no_button`/`identity_mismatch`/`error` short-circuit to retry without rescrape; only `no_signal`/unhandled fall through to `verifyViaScheduleRescrape`. Settle waits in `completeBookingOnDetailPageIfNavigated` tightened (600→300, 1500→800, 2000→1000 ms). Retry loop bails after 2 consecutive `not_on_schedule_page` rescrape outcomes (`detail_page_loop` failure).
- **Live confirming feedback (Task #60)**: `_state.confirmingPhase` (sniper-readiness) carries a sub-phase string ("Checking response…", "Verifying on detail page…", "Re-checking schedule…", "Retry N of M · checking response…") set at every transition in the post-click cascade, surfaced via `executionTiming.confirmingPhase`, and consumed by NowScreen's blue "Confirming registration…" banner so the user sees what the bot is doing.

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
