# YMCA Booker — Bug Taxonomy & System Invariants

> **Living engineering reference.**
> Update this document after major subsystem passes, not after every small
> patch.  The goal is systematic debugging, not exhaustive coverage.
>
> When a new bug appears: classify it against the families below, name the
> violated invariant, choose the highest-level fix available, and update the
> audit history if a subsystem pass was triggered.

---

## 1. Bug Families

Seven recurring families cover the vast majority of defects in this system.
Each new bug should map cleanly to one of them; if it does not, the family list
needs a new entry.

---

### Family 1 — Auth / Session Truth Mismatch

**Definition**
The system's internal belief about session validity diverges from the actual
FamilyWorks / Daxko session state.

**Common symptoms**
- Bot enters the booking flow and then gets an auth failure mid-registration
- "Login to Register" prompt appears inside the Playwright run after the session
  was believed valid
- `isAuthInProgress` is stuck `true` at startup, blocking all runs
- Warmup phase starts but the session ping immediately fails

**Typical root causes**
- `isAuthInProgress` flag not cleared on server restart (now cleared at startup
  in `auth-state.js`)
- `confirmedReady` written in the wrong order — truth must be written before
  readiness at every callsite (`confirmed-ready.js` write-order invariant)
- Tier-2 HTTP ping caches a stale "valid" answer that diverges from what
  Playwright actually sees in the browser session
- FamilyWorks session established on one domain (the embed), but bot navigates
  to the root domain first and loses it (the no-pre-login constraint)

**Example past bugs**
- `isAuthInProgress` not cleared on startup → bot never moved past auth check
- `confirmedReady` written before `readiness-state` → stale UI confidence shown
  after a real auth failure

---

### Family 2 — Class Truth / Freshness Mismatch

**Definition**
The system believes a class exists, is bookable, or occurs at a specific
date/time when the real YMCA schedule says otherwise.

**Common symptoms**
- "Class not found on schedule" despite the class being visible in the YMCA app
- Bot targets the wrong weekday or date
- Classifier returns `not_found` immediately before a successful Playwright run
  that finds the class
- Schedule cache has entries from a prior week that are treated as authoritative

**Typical root causes**
- Schedule cache entries for the correct class have the wrong `dateISO` or
  `dayOfWeek` due to a timezone bug in the entry-capture code
- `_isPastDate` evicts still-valid Pacific-"today" entries too early (UTC rolls
  to "tomorrow" at 5 PM PDT)
- FamilyWorks API response interception not firing (response listener detached
  too early, or page loaded from cache)
- Classtruth score too strict — fuzzy matching threshold rejects a valid class
  with a slightly different title

**Example past bugs**
- `_isPastDate` using UTC instead of Pacific → entries for afternoon classes
  evicted at 5 PM PDT, right when booking opens (fixed)
- "Class not found" at 3:58 AM because YMCA hadn't listed the Friday class yet
  (not a code bug — schedule latency)

---

### Family 3 — Persistence / Durability Gap

**Definition**
A job mutation is written to SQLite but not durably propagated to PostgreSQL
(or vice versa), or the seed file is not current, causing state loss after
a restart or redeploy.

**Common symptoms**
- A job or its settings disappear after restart
- `booking_open_ms` or `confirmed_ready` reverts to null unexpectedly
- PG shows stale data while SQLite has the correct value
- App comes back after a crash with the wrong phase (e.g. armed → idle)

**Typical root causes**
- Fire-and-forget PG sync that swallowed errors silently
- Missing write serializer — two concurrent writes to `seed-jobs.json` collide
- `pg-init.js` not reached at startup (e.g. port check failing for the wrong
  reason)
- A mutation route writing to SQLite without enqueuing a PG sync
- SQLite `data/app.db` not committed to the file layer before a hard restart

**Example past bugs**
- Removed fire-and-forget PG export; replaced with serialized sync queue
- Recovery Tools pass (Stages 1–10) added repair routes for the three main
  durability failure modes

---

### Family 4 — Timing / Sequencing / Retry Behavior

**Definition**
The bot executes a booking action at the wrong moment or with the wrong retry
cadence — too early, too late, too aggressively, or too slowly.

**Common symptoms**
- Registration attempt fires before the YMCA booking window is open
- Bot misses the window entirely (sniper phase never reached, or reached too
  late)
- Retry cooldowns are too long after a transient failure, causing the bot to
  sit idle during the window
- Warmup and sniper phases have the wrong boundary, causing premature arming

**Typical root causes**
- `computeBookingOpenMs` calculating the window in the wrong timezone (off by
  1 hour for Mountain-time clients)
- Scheduler tick granularity (60 s) too coarse for precise sniper timing
- Retry strategy applying long cooldowns for transient Playwright errors that
  should retry immediately
- `booking-window.js` not accounting for DST transition when the booking opens
  across a DST boundary

**Example past bugs**
- `computeBookingOpenMs` client fallback using `setHours()` in browser local tz
  → 1 hour early for Mountain-time users (fixed)
- Warmup/sniper phase boundary pass — arming too early consumed resources
  without improving registration success

---

### Family 5 — Playwright / Browser Transient Failure

**Definition**
The Playwright session encounters a transient browser or network issue
unrelated to auth or class state.  The failure is not reproducible on the
next attempt.

**Common symptoms**
- Random `TimeoutError` on `waitForFunction` or `waitForLoadState`
- Blank or spinner page in screenshot evidence with no clear cause
- "Navigation failed" or ERR_NETWORK_CHANGED mid-run
- One-time "class not found" that succeeds on the very next run

**Typical root causes**
- Chromium cold-start time in the Replit container exceeding the first-action
  timeout
- FamilyWorks schedule embed loading variably (3–15 s) depending on YMCA CDN
- Daxko API response latency causing the response-interception listener to see
  no data
- Playwright process not fully torn down from a previous run, causing port or
  process contention

**Example past bugs**
- `waitForFunction` timeout on tab discovery → now falls back to full scan
- Occasional "Login to Register" false positive when the embed renders slowly

---

### Family 6 — UI State Mismatch / Presentation Drift

**Definition**
The client displays a confidence or readiness level, phase label, or time
value that does not match the server's actual belief or the evidence freshness.

**Common symptoms**
- "Session verified" badge shown when the session has actually expired
- Countdown showing the wrong time for a user in a different timezone than
  Pacific
- "Booking open" phase shown 1 hour before the server's sniper actually arms
- UI still shows "booking" after a confirmed registration

**Typical root causes**
- `readinessResolver.ts` computing client-side confidence from stale server data
- Client-side `computeBookingOpenMs` fallback using browser local timezone
  instead of Pacific
- `timing.ts` / `bookingCycle.ts` phase boundaries not matching
  `booking-window.js` server constants
- Optimistic UI update not reverted when the server-side truth is later received

**Example past bugs**
- `computeBookingOpenMs` Mountain-timezone display bug (fixed)
- Date picker blur bug on iOS closing the native picker prematurely, leaving
  the displayed date stuck at today (fixed)

---

### Family 7 — Timezone / Clock Skew

**Definition**
A subsystem computes a date or time in the wrong timezone, producing
off-by-hours or off-by-one-day results in scheduling, display, or cache
eviction.

> This family often manifests *through* another family (e.g. a timezone bug
> in `_isPastDate` presents as a Class Truth symptom).  It is listed separately
> because the root-cause pattern is distinct and recurring, and the correct fix
> is always the same: use `Intl.DateTimeFormat` with `America/Los_Angeles`
> explicitly.  Never use `toISOString()`, `getDay()`, `getDate()`, or
> `setHours()` for Pacific-time decisions.

**Common symptoms**
- Schedule cache entry has correct title but wrong `dateISO` (off by one day)
- `dayOfWeek` in cache entry is one day earlier than expected
- Booking window opens or expires 1 hour off from the expected Pacific time
- Schedule entries for today's classes are evicted mid-afternoon
- Countdown is correct on a Pacific device but 1 hour off on a Mountain device

**Typical root causes**
- `new Date("YYYY-MM-DD")` parsed as UTC midnight, then read with local-time
  getters (`getDay()`, `getDate()`) — the UTC midnight instant maps to the
  previous evening in Pacific
- `toISOString().slice(0, 10)` returning UTC date instead of Pacific date for
  "today" comparisons
- `setHours(h, m)` in client code placing a time in the browser's local
  timezone instead of Pacific
- DST transitions causing a ±1 hour shift when booking crosses a spring-forward
  or fall-back boundary

**Example past bugs**
- `_isPastDate` in `scheduleCache.js` used UTC for "today" → evicted Pacific
  evening entries after 5 PM PDT (fixed)
- `computeBookingOpenMs` client fallback used `setHours()` in browser local tz
  → 1 hour early for Mountain-time users (fixed)

---

## 2. System Invariants

These are the rules that must always hold.  A bug is a violation of one or
more of these invariants.  When debugging, the fastest path is usually:
*which invariant broke?*

---

### INV-1 — Canonical Auth Truth

> **The system must read auth truth from one source only.**
> No module may derive session validity from its own local heuristic.

- Auth validity is owned by `auth-state.js` (`isSessionValid()`, `getAuthState()`).
- `confirmed-ready.js` is the sole writer of `confirmedReady`; no other module
  sets it directly.
- `isAuthInProgress` must be cleared at server startup before any scheduler
  tick runs.
- Violation signature: two subsystems disagree on whether the session is valid
  (one says yes, Playwright says no).

---

### INV-2 — Write-Order: confirmed-ready Before readiness

> **`confirmedReady` must be written before `readiness-state` at every callsite.**

If `readiness-state` is updated first, the UI can briefly display a confidence
level that the auth truth does not yet support.  Every path that changes both
must write `confirmed-ready.js` first, then `readiness-state.js`.

- Violation signature: UI shows "session verified" but the bot immediately
  fails auth on the next Playwright action.

---

### INV-3 — No Pre-Login Before FamilyWorks Embed

> **The bot must NOT authenticate to Daxko before clicking "Login to Register"
> inside the FamilyWorks schedule embed.**

FamilyWorks OAuth requires the login to originate from within the embed's own
flow.  Pre-logging into Daxko before reaching the embed causes the OAuth
redirect to fail or silently skip enrollment.

- Violation signature: bot reaches the registration modal but the class does
  not appear in the user's enrolled classes afterward.

---

### INV-4 — Class Truth Must Reflect Evidence Age

> **Stale class truth must not be treated as authoritative booking truth.**

A schedule cache entry older than the cache TTL must be treated as a hint,
not a guarantee.  The classTruth classifier must surface `freshness` to
callers; callers that require fresh truth must trigger a Playwright refresh
rather than acting on aging/stale cache data.

- Cache entries are tagged with `capturedAt`; the file is tagged with `savedAt`.
- Both `freshness` (per-entry) and `cacheFileFreshness` (file-level) must be
  checked before high-confidence booking decisions.
- Violation signature: bot proceeds to booking based on a cache entry from
  a prior week; class has since moved or been cancelled.

---

### INV-5 — Pacific Time for All YMCA Date/Time Arithmetic

> **Every date or time computation that relates to YMCA class scheduling must
> use `America/Los_Angeles` explicitly via `Intl.DateTimeFormat` or
> `Date.UTC + offset`.  `toISOString()`, `getDay()`, `getDate()`, and
> `setHours()` must never be used for Pacific-relative decisions.**

Pacific is UTC-7 (PDT summer) / UTC-8 (PST winter).  The UTC date rolls to
"tomorrow" at 5 PM PDT in summer — the same time evening-class booking windows
are open.

- Server: use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`
  for date-string comparisons.
- Server: use `booking-window.js` helpers for all window arithmetic.
- Client: use `Date.UTC + _pacificOffsetHours()` for any fallback computation;
  never `setHours()`.
- Violation signature: date/time appears correct on a Pacific device but is
  off by 1 hour or 1 day on Mountain/Central devices, or after 5 PM PDT.

---

### INV-6 — Durability: SQLite → seed-jobs.json → PostgreSQL

> **Any mutation that affects future scheduling must be written durably through
> the full persistence chain before the response is returned.**

Approved mutation path:
1. Write to SQLite (`data/app.db`) via `jobs.js`
2. Update `seed-jobs.json` (the cross-restart snapshot)
3. Enqueue a PG sync via the serialized sync queue in `pg-sync.js`

Fire-and-forget PG writes are forbidden.  A mutation that lands only in SQLite
is lost on the next redeploy.  A mutation that lands only in PG is invisible
to the dev environment.

- Violation signature: job or setting is correct after mutation but reverts
  to the old value after a restart or redeploy.

---

### INV-7 — Retry Cadence Must Not Waste the Booking Window

> **Transient failures inside the active booking window must retry quickly.
> Long cooldowns are only appropriate outside the window.**

Retry strategy (`retry-strategy.js`) applies different backoff curves based on
failure type and phase.  Inside the sniper/warmup window, any cooldown longer
than a few seconds risks missing the booking.

- Violation signature: bot fails with a transient Playwright error at T+0s,
  applies a 5-minute cooldown, and misses the window entirely.

---

### INV-8 — UI Confidence Must Not Exceed Evidence Freshness

> **The client must not display a confidence level or readiness badge that is
> stronger than the freshest server evidence supports.**

`readinessResolver.ts` derives UI confidence from server-supplied data.  If the
server data is aging or stale, the UI must reflect that uncertainty rather than
displaying the last-known high-confidence state indefinitely.

- "Session verified" must not persist on screen after a session failure is known.
- "Class found" must decay toward "checking…" if the cache entry is stale and
  no fresh Playwright run has succeeded recently.
- Violation signature: UI shows a confident, positive state while the bot is
  silently failing in the background.

---

## 3. Classifying a New Bug

Use this checklist every time a new issue appears.  Work top-to-bottom; stop
at the first answer that fits.

**Step 1 — Name the user-visible symptom**

| Symptom | Likely family |
|---------|---------------|
| "Class not found on schedule" | Family 2 or 7 |
| Session / auth failure mid-run | Family 1 |
| Countdown or phase wrong on screen | Family 6 or 7 |
| Registration fired at wrong time | Family 4 or 7 |
| Job/setting lost after restart | Family 3 |
| One-off timeout, blank page, random failure | Family 5 |
| UI shows positive state while bot is failing | Family 6 |
| Date or day-of-week wrong in cache or display | Family 7 |

**Step 2 — Trace backward through the layers**

```
User symptom
  └─ UI display (NowScreen, readinessResolver, timing.ts)
       └─ API response (server.js, scheduler routes)
            └─ Scheduler decision (tick.js, booking-window.js, retry-strategy.js)
                 └─ Bot execution (register-pilates.js, session-ping.js)
                      └─ Data source (scheduleCache.js, classTruth.js, auth-state.js, jobs.js)
```

Ask: *at which layer does the wrong value first appear?*  That layer owns the
root cause, even if the symptom surfaces much higher.

**Step 3 — Match to a bug family**

```
Wrong date / time?                 → Family 7 (Timezone / Clock Skew)
  ↓ after ruling out timezone
Wrong class / availability belief? → Family 2 (Class Truth / Freshness)
Auth or session wrong?             → Family 1 (Auth / Session Truth)
State lost on restart?             → Family 3 (Persistence / Durability)
Fired at wrong time / missed?      → Family 4 (Timing / Sequencing)
Random one-off, retries OK?        → Family 5 (Playwright Transient)
UI shows wrong confidence?         → Family 6 (UI State Mismatch)
```

**Step 4 — Name the violated invariant**

| Family | Primary invariant |
|--------|-------------------|
| 1 — Auth | INV-1 (canonical auth truth) or INV-2 (write-order) |
| 2 — Class truth | INV-4 (freshness) |
| 3 — Persistence | INV-6 (durability chain) |
| 4 — Timing | INV-7 (retry cadence) |
| 5 — Playwright | None broken — transient environment issue |
| 6 — UI | INV-8 (confidence ≤ freshness) |
| 7 — Timezone | INV-5 (Pacific time explicit) |

If no invariant fits, the invariant list needs a new entry.

**Step 5 — One-off bug or repeated family leak?**

| Answer | Action |
|--------|--------|
| One-off, narrow, unlikely to recur | Patch the single callsite |
| Same family has appeared 2+ times | Audit the full subsystem for the pattern |
| The invariant has no enforcement | Add a guard or centralise the truth |

Rule of thumb: if you are writing the same kind of fix for the third time in
the same subsystem, write a helper or enforce the invariant instead.

**Step 6 — Evidence check before fixing**

- [ ] Exact log line or screenshot showing the wrong value
- [ ] Subsystem file where the wrong value *originates* (not just where it surfaces)
- [ ] Local repro or clear mental model of when the bug fires
- [ ] A way to verify the fix (log output, sanity script, or screenshot comparison)

---

## 4. Bug Family → Subsystem / File Map

Start the investigation in the files listed below.  This is a starting point,
not an exhaustive inventory.

---

### Family 1 — Auth / Session Truth Mismatch

| File | Role |
|------|------|
| `src/bot/auth-state.js` | Canonical session truth; `isSessionValid()`, `getAuthState()` |
| `src/bot/confirmed-ready.js` | Sole writer of `confirmedReady`; write-order invariant lives here |
| `src/bot/readiness-state.js` | Written *after* confirmed-ready; drives UI confidence |
| `src/bot/session-check.js` | Lightweight session validity check before each run |
| `src/bot/session-ping.js` | Tier-1/2 HTTP ping to validate FamilyWorks + Daxko sessions |
| `src/bot/session-validator.js` | Deeper session validation used during warmup |
| `src/scheduler/session-keepalive.js` | Periodic keepalive to prevent session expiry |
| `src/bot/daxko-session.js` | Low-level Daxko cookie/token management |
| `src/bot/auth-lock.js` | Prevents concurrent auth attempts; lock state |
| `src/bot/settings-auth.js` | Credential store (YMCA_EMAIL / YMCA_PASSWORD from env) |

**Key questions:** Is `isAuthInProgress` stuck? Was `confirmedReady` written before or after `readiness-state`? Did the Tier-2 ping actually hit FamilyWorks, or was it a cached response?

---

### Family 2 — Class Truth / Freshness Mismatch

| File | Role |
|------|------|
| `src/classifier/scheduleCache.js` | Schedule cache: read, write, merge, eviction, `_isPastDate` |
| `src/classifier/classTruth.js` | Classifier: scores entries against job, surfaces freshness |
| `src/bot/confirmed-ready.js` | Writes cache-based readiness result to disk |
| `src/bot/scrape-schedule.js` | Standalone Playwright scraper for schedule refresh |
| `client/src/lib/classTruth.ts` | Client-side classTruth type definitions and helpers |
| `client/src/screens/ToolsScreen.tsx` | RecoveryPanel — force-refresh and cache repair tools |

**Key questions:** How old is the cache entry (`capturedAt`)? Does `dateISO` match the job's `target_date`? Did the API response interception listener fire? Is `_isPastDate` evicting valid entries?

---

### Family 3 — Persistence / Durability Gap

| File | Role |
|------|------|
| `src/db/jobs.js` | SQLite job CRUD — all mutations go through here first |
| `src/db/pg-sync.js` | Serialised PG sync queue; enqueued by mutation routes |
| `src/db/pg-init.js` | Startup restore: PG → `seed-jobs.json` on prod boot |
| `src/db/init.js` | SQLite schema initialisation |
| `src/web/server.js` | Mutation routes (job add/update/delete) — must enqueue PG sync |
| `data/seed-jobs.json` | Cross-restart snapshot; must be current before any restart |

**Key questions:** Was the PG sync enqueued after the mutation? Did `pg-init.js` run at startup (prod only, `PORT === 5000`)? Is `seed-jobs.json` out of date?

---

### Family 4 — Timing / Sequencing / Retry Behavior

| File | Role |
|------|------|
| `src/scheduler/booking-window.js` | Authoritative booking-open epoch ms; Pacific-time source of truth |
| `src/scheduler/tick.js` | Main scheduler tick — decides phase and triggers runs |
| `src/scheduler/retry-strategy.js` | Cooldown curves by failure type and phase |
| `src/scheduler/preflight-loop.js` | Pre-window preflight cadence |
| `src/scheduler/execution-timing.js` | Learned timing offsets applied to sniper arming |
| `src/scheduler/timing-learner.js` | Accumulates timing observations across runs |
| `src/scheduler/timing-metrics.js` | Exposes timing stats to server routes |
| `src/scheduler/escalation.js` | Escalation policy for repeated failures |
| `src/bot/register-pilates.js` | Actual Playwright run; `targetDate` → `targetDayNum` path |
| `client/src/screens/NowScreen.tsx` | Client-side phase/countdown; `computeBookingOpenMs` fallback |
| `client/src/lib/timing.ts` | Client phase boundary constants — must match `booking-window.js` |

**Key questions:** Is `bookingOpenMs` correct (Pacific-time)? Is the scheduler tick granularity too coarse? Is the retry cooldown longer than the remaining booking window? Does `timing.ts` match `booking-window.js` constants?

---

### Family 5 — Playwright / Browser Transient Failure

| File | Role |
|------|------|
| `src/bot/register-pilates.js` | All Playwright logic; timeout values, waitForFunction gates |
| `src/bot/screenshot-capture.js` | Evidence capture; check for blank/spinner screenshots |
| `src/bot/screenshot-retention.js` | Screenshot cleanup and retention policy |
| `src/bot/replay-store.js` | Run replay log; check for repeated vs one-off failures |
| `src/bot/armed-state.js` | Sniper-armed flag; check if a prior run left it set |
| `src/scheduler/run-from-db.js` | Job runner entrypoint; wraps register-pilates invocation |

**Key questions:** Is the failure reproducible on retry? Does the screenshot show a blank/spinner page? Did a prior run leave a zombie Playwright process? Is the `waitForFunction` timeout appropriate for FamilyWorks embed load time?

---

### Family 6 — UI State Mismatch / Presentation Drift

| File | Role |
|------|------|
| `client/src/screens/NowScreen.tsx` | Primary booking UI; phase, countdown, confidence display |
| `client/src/lib/readinessResolver.ts` | Derives UI confidence from server-supplied readiness data |
| `client/src/lib/readinessTypes.ts` | Readiness type definitions and freshness thresholds |
| `client/src/lib/confidence.ts` | Confidence score → badge label mapping |
| `client/src/lib/timing.ts` | Client phase boundaries and timing helpers |
| `client/src/lib/bookingCycle.ts` | Booking cycle state machine used by NowScreen |
| `client/src/lib/sniperArmed.ts` | Sniper-armed state consumed by UI |
| `client/src/screens/PlanScreen.tsx` | Date/time input; date picker bugs surface here |
| `client/src/lib/api.ts` | API polling; stale-data risk if polling interval is too long |

**Key questions:** Is the server returning fresh readiness data? Does `readinessResolver` decay confidence correctly when data ages? Do client phase boundaries match the server? Is the countdown correct for non-Pacific timezones?

---

### Family 7 — Timezone / Clock Skew

Timezone bugs can originate in any layer.  Check these files in order:

| File | Risk area |
|------|-----------|
| `src/classifier/scheduleCache.js` | `_isPastDate` "today" comparison — must use Pacific |
| `src/bot/register-pilates.js` | `start_date_date` → `dayOfWeek` + `dateISO` mapping |
| `src/scheduler/booking-window.js` | Booking-open epoch calculation — canonical Pacific helper |
| `client/src/screens/NowScreen.tsx` | `computeBookingOpenMs` fallback — must use `Date.UTC + offset` |
| `client/src/lib/timing.ts` | Any "opens today at X" string formatting |
| `client/src/screens/PlanScreen.tsx` | `target_date` parsing and `nextOccurrenceISO` computation |

**Key questions:** Is `Intl.DateTimeFormat` with `America/Los_Angeles` used? Is `toISOString().slice(0, 10)` used anywhere for a Pacific "today" decision? Is `setHours()` used in client code where Pacific time is needed?

---

## 5. Preferred Fix Types

When the root cause is clear, choose the fix at the highest level possible.
Symptom patches are the last resort, not the first move.

```
1. Make the wrong path impossible          (structural fix)
2. Centralise truth in one place           (canonical source fix)
3. Add freshness / ordering guards         (defensive guard fix)
4. Add diagnostics / observability         (evidence fix)
5. Patch the single symptom callsite       (last resort)
```

Work down this list until one level fits.  If level 5 is chosen, note
explicitly why a higher-level fix was not feasible.

---

**Level 1 — Make the Wrong Path Impossible**

Remove the API, field, or code path that allowed the bad state to be reached
at all.  After this fix the bug cannot recur even with incorrect callers.

*Examples:* Removing fire-and-forget PG export call. Removing `e.target.blur()`
from date picker `onChange`. Unconditional `isAuthInProgress` clear at startup.

---

**Level 2 — Centralise Truth in One Place**

When multiple callers each computed the same value independently and diverged,
collapse to a single authoritative module.

*Examples:* `auth-state.js` / `isSessionValid()`. `booking-window.js` as sole
source of booking-open epoch ms. `confirmed-ready.js` as sole writer of
`confirmedReady`.

---

**Level 3 — Add Freshness / Ordering Guards**

When centralising is not feasible, add guards that enforce ordering or reject
stale values before they propagate.

*Examples:* Per-entry `capturedAt` freshness tags. Write-order invariant
documented at every callsite in `confirmed-ready.js`. `_isPastDate` using
Pacific "today". PG sync serialiser preventing concurrent writes.

---

**Level 4 — Add Diagnostics / Observability**

When the bug is hard to prevent or guard against, make it immediately visible
so it is caught on the next occurrence rather than failing silently.

*Examples:* Screenshot capture on every Playwright run. `replay-store.js` run
log. RecoveryPanel in ToolsScreen. `timing-metrics.js` for booking window
latency regressions.

---

**Level 5 — Patch the Single Symptom (Last Resort)**

Fix only the one callsite where the wrong value appears.

Caution signs that a higher level is needed instead:
- The same symptom has appeared twice before
- The patch duplicates logic that already exists elsewhere
- The fix requires a comment explaining why the code is correct
- The bug was only found via a production incident

---

**Quick reference**

| Situation | Preferred level |
|-----------|----------------|
| Bad code path should not exist | 1 — Delete it |
| Two modules compute the same truth differently | 2 — Centralise |
| Value can be wrong but can be rejected at use | 3 — Guard |
| Bug is transient or environment-specific | 4 — Observe |
| Narrow one-off with no recurrence risk | 5 — Patch |
| Same family appeared before | Re-examine: probably needs Level 1–3 |

---

## 6. When to Audit vs When to Patch

> **Default rule: patch immediately. Audit only when the evidence demands it.**
> The trigger is pattern repetition, not bug severity.

---

**Patch immediately when**
- The bug is a narrow, one-off callsite error with a clear cause
- The family has not appeared before in this subsystem
- The fix can be verified quickly with a log line or sanity script
- The subsystem has been recently audited and is otherwise stable

---

**Audit the subsystem when** one or more of the following is true:

| Trigger | What it means |
|---------|---------------|
| Same family appeared **2+ times** in the same subsystem | Invariant not enforced; root cause is structural |
| Patch required a **comment explaining why the code is correct** | Code is not self-evidently safe; a guard is needed instead |
| Bug only discovered **via production failure** | Subsystem has an observability gap |
| A **major feature or refactor** touched the subsystem | Existing invariants may have drifted |
| Fix required **touching more than 3 files** | Problem is likely systemic, not isolated |

---

**What a focused audit looks like**

An audit is not a rewrite.  It is a targeted review of one subsystem against
its invariants.

1. List the invariants that apply to this subsystem (Section 2 above)
2. Read every file in the subsystem map (Section 4 above)
3. For each invariant: confirm it is enforced at every callsite
4. Note any callsite that relies on a comment or convention rather than code
   enforcement — those are the audit findings
5. Fix findings at the highest fix level possible (Section 5 above)
6. Add a diagnostic (Level 4) for anything that cannot be structurally prevented

An audit should produce a small number of targeted fixes, not a large refactor.

---

**Subsystem audit history** — update after each major pass

| Subsystem | Last audited | Trigger | Outcome |
|-----------|-------------|---------|---------|
| Auth / session truth | Earlier session | `isAuthInProgress` stuck bug | Canonical auth truth centralised; write-order invariant documented |
| Persistence / durability | Recovery Tools pass | Fire-and-forget PG sync + seed divergence | Serialised PG sync queue; three repair routes added |
| Class truth / freshness | Apr 2026 session | `_isPastDate` UTC bug | Pacific-time fix applied; `computeBookingOpenMs` fallback corrected |
| Timing / booking window | Warmup/sniper pass | Phase boundary and arming bugs | `booking-window.js` made authoritative; adaptive arming added |
| UI state / presentation | Ongoing | Date picker iOS bug; timezone display | Point patches applied; no structural audit needed yet |
| Timezone (cross-cutting) | Apr 2026 session | Mountain-time user report | INV-5 documented; two callsites fixed; full callsite audit due if a third appears |

---

**Do not audit when**
- A single patch fixed the issue and the family has not recurred
- The change is a small wording or style fix with no logic impact
- You are mid-way through an unrelated feature — finish the feature first

---

## 7. Known Current High-Risk Areas

Ordered by likelihood of near-term impact.  Reassess after each major pass.

---

### Risk 1 — Timezone (Family 7): Third Callsite Likely Exists

**Status:** Two callsites fixed (Apr 2026): `_isPastDate` and
`computeBookingOpenMs` fallback.  INV-5 is documented but has no structural
enforcement — it relies on convention, not code.

**Concern:** Any new date/time code will naturally reach for `new Date()`,
`getDay()`, `setHours()`, or `toISOString()`.  The next DST transition
(November 2026 fall-back) is a concrete upcoming test.

**Watch for:** Off-by-one-day in schedule cache; countdown wrong for
Mountain/Central users; booking window 1 hour off after DST.

**Audit trigger:** A third timezone-family bug anywhere → audit every
date/time callsite in the codebase against INV-5.

---

### Risk 2 — First-Click Latency at Window Open (Family 4 / 5)

**Status:** FamilyWorks embed takes 3–15 s to load.  Total click-to-
confirmation latency is variable and not fully characterised.

**Concern:** For popular classes, finishing the registration flow in the
first seconds after window open matters.  Warmup pre-load timing is not
guaranteed.

**Watch for:** "Class not found" immediately after window opens, then
success on retry a few seconds later.

**Audit trigger:** A missed booking where the log shows the bot reached the
class but failed to reach the modal within the first 30 s of window open.

---

### Risk 3 — FamilyWorks OAuth Fragility (Family 1 / INV-3)

**Status:** INV-3 (no pre-login before the embed) is enforced by convention
only.  The failure mode is silent — the bot run looks successful but the
class never appears in enrolled classes.

**Watch for:** All steps checked in the bot UI, but no YMCA confirmation
email and no class in the user's enrolled list.

**Audit trigger:** Any change to the navigation sequence in
`register-pilates.js` that touches the pre-embed phase — review INV-3
explicitly before merging.

---

### Risk 4 — Schedule Cache Cold-Start at Warmup (Family 2)

**Status:** If the cache is empty or stale at warmup time (after a redeploy,
or if the YMCA API returned no data on the morning preflight), the classifier
returns `not_found` and the bot must trigger a fresh Playwright run to
recover.

**Watch for:** "Class not found on schedule" during warmup, followed by
success once a fresh scrape completes.

**Audit trigger:** Two consecutive booking cycles entering warmup with a
stale or empty cache for the target class.

---

### Risk 5 — UI Confidence Decay Under Sustained Failure (Family 6 / INV-8)

**Status:** The decay path in `readinessResolver.ts` is exercised far less
often than the happy path.  A sustained bot failure over several hours may
leave the UI displaying a stale positive state.

**Watch for:** 30+ minutes with no successful session ping, but the UI
still showing a positive readiness badge.

**Audit trigger:** Any report of the UI appearing healthy while the bot
was not actually progressing.
