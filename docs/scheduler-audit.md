# Scheduler + Booking Phase Model — Audit

**Scope:** discovery only. No production code changes are made by this task.
**Goal:** map every concurrent runner over the active job set, every phase
taxonomy, and every duplication of "near-open" math, so the next round of
work can collapse drift, eliminate races, and lower the maintenance cost of
the sniper engine.

**Files audited (exhaustive):**

```
src/scheduler/
  tick.js                  run-eligible-jobs-once.js
  booking-window.js        run-scheduler-loop.js
  preflight-loop.js        run-scheduler-once.js
  auto-preflight.js        booking-bridge.js
  execution-timing.js      retry-strategy.js
  timing-learner.js        timing-metrics.js
  scheduler-state.js       escalation.js
  session-keepalive.js     job-consistency.js
src/web/server.js          (manual preflight, /api/state, /api/readiness)
client/src/lib/sniperPhase.ts
client/src/screens/NowScreen.tsx, PlanScreen.tsx, ToolsScreen.tsx
```

---

## 1. Three independent runners, one job set

Every 60 s the server fires three independent loops over the same
`getAllJobs().filter(is_active === 1)` set. Each owns a different *slice* of
the timeline, but each re-derives phase, re-checks auth, and writes its own
state file. Only weak coordination exists (the `jobState.active` flag and
the `auth-lock` file).

| Runner | Entry | Cadence | Phase model used | Owns |
|---|---|---|---|---|
| **Tick** | `tick.js` `runTick()` via `run-scheduler-loop.js` | 60 s | `booking-window.getPhase` (`too_early`/`warmup`/`sniper`/`late`) | Real booking attempts. Inactivates past one-off jobs. Records run-speed. |
| **Auto-preflight** | `auto-preflight.checkAutoPreflights()` (called from `server.js` `runScheduledTick`) | 60 s with **3 fixed checkpoints** at T-30/T-10/T-2 ± 90 s | `booking-window.getPhase` | Discrete session-warming preflight at three named checkpoints; HTTP-ping fast path; T-2 needs-attention signal. |
| **Preflight loop** | `preflight-loop.runPreflightLoop()` (called from `server.js`) | 60 s **plus self-scheduling burst timers** (5–20 s during burst) | Both `booking-window.getPhase` AND `execution-timing.computeExecutionTiming` (`waiting`/`warmup`/`armed`/`executing`/`confirming`) | Continuous freshness, micro-burst near open, preempt launch, immediate-trigger on liveTruth flip, hot-retry chain after burst handoff. |

These are **not** layered cleanly in time — they overlap heavily inside the
30 min window, and the only thing keeping them out of each other's way is
the `running` boolean inside each module plus the `jobState.active` /
`isLocked()` cross-cutting flags. See §5 below for the failure modes that
fall out of this.

### Manual preflight is a fourth, ungoverned path

`POST /api/preflight` in `server.js` (L3964–L3986) calls
`runBookingJob({…}, { preflightOnly: true })` directly inside a fire-and-forget
IIFE. It does **not** consult `preflight-loop.isRunning()`,
`auto-preflight.running`, or the per-job cooldown.

Critically, it also does **not** go through `runInBackground` (`server.js`
L3840–L3854) and so it does **not** set `jobState.active`. `jobState` is
only mutated by `runInBackground`. That means:

* `tick.js`'s `isActive` callback (which reads `jobState.active`,
  `server.js` L_runScheduledTick_) returns `false` during a manual preflight,
  so a tick can land on top of one.
* `preflight-loop.runPreflightLoop({ isActive })` (`preflight-loop.js`
  L856–L864) likewise sees `isActive=false` and will start a burst on top
  of a manual preflight.
* The only thing keeping these in line is the auth-lock file
  (`isLocked()`) acquired inside `runBookingJob`'s auth phase. That lock
  is per-process and does serialize the browser launches, but it does
  **not** prevent a stacked queue of three browser launches behind it
  (manual preflight + auto-preflight T-2 + burst), and it does not
  surface as a structured "deferred" event anywhere.

This is the most plausible culprit for the "ghost preflight job ID"
pattern noted in the Yoga Nidra disappear-cycle investigation
(Task #68): a manual preflight clicked from the UI and an auto-preflight
checkpoint can both be in flight against the same job within seconds of
each other, and only the second one's writes to `sniper-state.json` are
visible to the UI.

---

## 2. Two parallel phase taxonomies

Two phase enums govern the booking lifecycle. Their boundaries do not align.

```
                                  −10 min     −3 min    −1 min  −45 s   open
                                     │           │         │       │     │
booking-window.getPhase   too_early │  warmup ─────────────│ sniper│ late
                                     │           │         │       │     │
execution-timing.phase     waiting  ──────────│ warmup  │ armed │      executing → confirming
```

* `booking-window` boundaries: `WARMUP_MS = 10 min`, `SNIPER_MS = 1 min`.
* `execution-timing` boundaries: `WARMUP_OFFSET_MS = 3 min`, `ARMED_OFFSET_MS = 45 s`.

Result: between **−10 min and −3 min**, the scheduler sees `warmup` (eligible
to launch real bookings) while execution-timing still says `waiting`.
Between **−1 min and −45 s**, scheduler is in `sniper` while execution is
still `warmup`. Both views are internally consistent, but every consumer
must remember which one to read, and the two are computed independently for
each job on every tick.

A third taxonomy lives client-side (`client/src/lib/sniperPhase.ts`):
`monitoring/locked/armed/countdown/firing/confirming`. It is purely a
display-layer mapping that *derives* its state by reading both server
phases plus `armedState` and `bookingActive`. The mapping is in one place
(good) but it consumes both phase enums (so any change to either ripples
into the visualizer).

A fourth taxonomy — the bot's `ExecutionPhase`
(`AUTH/NAVIGATION/DISCOVERY/VERIFY/MODAL/ACTION/CONFIRMATION/RECOVERY/SYSTEM`)
— is used only in failure records and Tools. `ToolsScreen.tsx` `PHASE_LABELS`
contains all four taxonomies merged into a single map.

---

## 3. Duplication of `getPhase()` and "near-open" math

### 3.1 `getPhase()` call sites

```
src/scheduler/tick.js                   1 call/job in tick loop
src/scheduler/preflight-loop.js         1 call/job in main loop  (+ N calls in burst)
src/scheduler/auto-preflight.js         2 calls/job (getNextTrigger + checkAutoPreflights)
src/scheduler/run-eligible-jobs-once.js 1 call/job (legacy CLI path; see §6)
src/web/server.js                       2 sites (jobInfo helper L213, /api/state L5183)
```

For 3 active jobs at the 60 s cadence, the system computes phase ~21 times
per minute even before the burst timer recomputes via
`computeExecutionTiming`, which itself calls `getBookingWindow` again. The
calculation is cheap, but the *semantics* are not — every call site picks
its own boundary constants and its own conventions for what a `null`
`target_date` means.

### 3.2 "Near-open" budgets / windows

Every module has its own constants for "how close to open is close enough."

| Constant | File | Value | Purpose |
|---|---|---|---|
| `WARMUP_MS` | booking-window.js | 10 min | scheduler `warmup` boundary |
| `SNIPER_MS` | booking-window.js | 1 min | scheduler `sniper` boundary |
| `WARMUP_OFFSET_MS` | execution-timing.js | 3 min | execution `warmup` boundary |
| `ARMED_OFFSET_MS` | execution-timing.js | 45 s | execution `armed` boundary |
| `TRIGGERS[].windowMs` | auto-preflight.js | 30 / 10 / 2 min | discrete checkpoint anchors |
| `TRIGGERS[].toleranceMs` | auto-preflight.js | 90 s | half-width of each checkpoint |
| `MIN_INTERVAL_MS` | preflight-loop.js | 3 min | min spacing of background runs |
| `ACTIVE_HORIZON_MS` | preflight-loop.js | 24 h | run only inside this horizon |
| `AUTO_PREFLIGHT_OWNS_MS` | preflight-loop.js | 30 min | yield to auto-preflight |
| `BURST_WINDOW_AFTER_MS` | preflight-loop.js | 90 s | stop bursting after open |
| `IMMEDIATE_FIRE_MAX_MS_UNTIL_OPEN` | preflight-loop.js | 60 s | immediate-trigger envelope |
| `IMMEDIATE_TRIGGER_COOLDOWN_MS` | preflight-loop.js | 60 s | per-job lockout |
| `HOT_RETRY_DELAY_MS` | preflight-loop.js | 5 s | between hot-retry attempts |
| `MAX_HOT_RETRIES` | preflight-loop.js | 3 | hot-retry cap |
| `MAX_BURST_RUNS` | preflight-loop.js | 8 | burst cap |
| `COOLDOWN_MS` | tick.js | 30 min | warmup-phase cooldown |
| `COOLDOWN_SNIPER_MS` | tick.js | 90 s | sniper cooldown |
| `COOLDOWN_LATE_MS` | tick.js | 60 s | late cooldown |
| `AUTH_BLOCK_STALE_MS` | tick.js, preflight-loop.js, auto-preflight.js | 20 min | auth-fail backoff |
| `AUTH_BLOCK_STALE_TIMEOUT_MS` | tick.js, preflight-loop.js | 5 min | timeout-fail backoff |

The auth-block constants (`AUTH_BLOCK_STALE_MS`, `_TIMEOUT_MS`) are
literally copy-pasted across three modules with the same comment block.
A change to one is silently desynchronized from the others.

### 3.3 Client-side reimplementation

`client/src/screens/NowScreen.tsx` `computeBookingOpenMs` (L83) reimplements
the 3-day-before, 1-hour-before booking-open math in TypeScript as a
fallback when the API doesn't surface `bookingOpenMs`. Then `derivePhase`
(L143) reimplements the four-phase boundary check using the same `WARMUP_MS`
/ `SNIPER_MS` constants — independently. Any change to
`booking-window.getPhase` server-side must be mirrored here by hand.

Phase-to-label maps are also duplicated in `NowScreen.tsx`, `PlanScreen.tsx`,
`ToolsScreen.tsx`, and `server.js` — each with subtly different copy. Task
**#73** in the existing queue addresses the *label* drift; this audit
flags the underlying *math* drift, which is upstream of it.

---

## 4. Phase-eligibility lists drift

```js
src/scheduler/tick.js:                    ['warmup', 'sniper', 'late']
src/scheduler/run-eligible-jobs-once.js:  ['warmup', 'sniper']         // missing 'late'
src/scheduler/preflight-loop.js:          phase === 'too_early' only
src/scheduler/auto-preflight.js:          skip 'sniper' and 'late'
```

`run-eligible-jobs-once.js` is the standalone CLI entry behind
`npm run scheduler:run`. It treats `late` as ineligible — the opposite of
what `tick.js` does. If anyone ever invokes it for a class whose window has
already opened, it will silently no-op. Either it is dead code (very
likely — `run-scheduler-once.js` is the actual server-side single-tick
runner) and should be removed, or it must align with `tick.js`.

---

## 5. Reliability gaps + race conditions

### 5.1 Three independent `running` flags

* `tick.js`         → `runningJobs: Set<jobId>` (L37)
* `auto-preflight`  → `running: boolean` (module-level, L52)
* `preflight-loop`  → `running: boolean` (module-level, L98)

Cross-runner coordination is done via:
1. `jobState.active` — set **only** by `runInBackground`
   (`server.js` L3840–L3854), and indirectly by `triggerBookingFromBurst`
   via the same path (`booking-bridge.js`).
2. The `auth-lock` file (`isLocked()`), checked at the top of each
   runner's main loop.
3. The `isActive` callback passed from `server.js` to each runner —
   which simply reads `jobState.active`.

**Manual preflight (`POST /api/preflight`, `server.js` L3964–L3986)**
calls `runBookingJob` directly inside an IIFE; it does **not** set
`jobState.active` (only `runInBackground` does). Therefore the manual
preflight is invisible to:
* `tick.js` `runScheduledTick` `isActive` check (it returns `false`),
* `preflight-loop.runPreflightLoop({ isActive })` (`preflight-loop.js`
  L856–L864) — `isActive=false` so the loop and its bursts proceed,
* `auto-preflight.checkAutoPreflights` `isActive` short-circuit
  (`auto-preflight.js`, top of function).

Manual preflight also passes `preflightOnly: true`, which bypasses the
booking attempt itself, but it still launches a full browser session
through `runBookingJob` — meaning the per-job cooldown that `tick.js`
enforces (`COOLDOWN_*_MS` in tick.js L23–L24) does not apply.

Result: a manual preflight at T-2 min can collide with the
auto-preflight T-2 trigger AND with the burst timer's `armed`-phase
fire. The only thing serializing them is the `auth-lock` file acquired
inside `runBookingJob`'s auth phase. That lock prevents simultaneous
browser activity but does **not** prevent the same job's
`sniper-state.json` from being overwritten in arbitrary order by three
near-simultaneous runs.

### 5.2 `firedThisCycle` is in-memory only (auto-preflight)

`auto-preflight.js` L55: `const firedThisCycle = new Set()`. Restarting the
server between T-30 firing and T-10 firing wipes the gate; if T-30 is still
inside its 90 s tolerance after the restart, it will fire **again** and
double-launch. This is the most likely contributor to "preflight job ran
right after restart" behavior reported in the Yoga Nidra debug session.

### 5.3 Burst timers are in-memory `setTimeout` handles

`burstTimers[jobId]` (preflight-loop L105) holds raw `setTimeout` IDs. They
do not survive a restart, which is acceptable — but no `unref()` or shutdown
hook is wired, so a kill mid-burst leaves them as outstanding handles. There
is no metric / observability on burst depth.

### 5.4 Hot-retry skips the auth-lock check at fire time

`scheduleHotRetry` (`preflight-loop.js` L800–L846) → `triggerBookingFromBurst`
(`booking-bridge.js`) only consults `_isActive()` (booking active). It does
**not** call `isLocked()`. By contrast, `runBurstCheck` (`preflight-loop.js`
L882–L926, `runPreflightLoop` L959–L962) does check `isLocked()` at the top
of each pass. After the first burst-handoff fire, the chained hot-retry
attempts (up to `MAX_HOT_RETRIES = 3`, every `HOT_RETRY_DELAY_MS = 5 s`)
can race a manual sign-in (`POST /api/login`) or a `session-keepalive`
run that grabs the auth lock between attempts. The symptom would be a
hot retry that surfaces an auth failure right after a successful first
attempt — distinguishable in logs because the first attempt's auth phase
succeeded.

### 5.5 Past-class detection lives only in `tick.js`

`isPastClass()` filtering and `inactivatePastJobs()` are only invoked from
`tick.js` (L90, L149). `auto-preflight.js` and `preflight-loop.js` filter
by `is_active === 1` but never call `isPastClass`. Between two ticks (60 s)
a one-off class can pass its date+time and the *other* runners will keep
trying to compute its phase. The only thing saving them today is that
`getPhase` returns `late` for a past one-off and the scheduler runners
either skip it (auto-preflight) or run it pointlessly — but a `tick.js`
`inactivatePastJobs` call eventually catches it.

### 5.6 Three writers, one canonical readiness file

`refreshConfirmedReadyState` (in `src/bot/sniper-readiness.js`) is called from:
* `tick.js`              with `source: 'tick'`
* `auto-preflight.js`    with `source: pingConfirmed ? 'ping' : 'browser'`
* `preflight-loop.js`    with `source: 'browser'` (burst + main loop + error path)

There is no last-writer-wins ordering guarantee — writes happen in
whichever order the three runners' async work returns. A burst that
started at T-90 s and finishes at T-15 s can clobber the confirmed-ready
record written by the actual booking attempt that runs at T=0. The
`confirmed-ready` consumer (the Tools screen and `/api/state`) treats
every write as authoritative regardless of source. There is no
`writtenAt`/`writtenBy` field that downstream code uses to prefer the
freshest *real-booking* result over a stale background ping.

### 5.7 No structured visibility into "who is currently doing what"

There is no `/api/scheduler/status` endpoint that says "preflight-loop is
in burst run 4/8 for job 7, hot-retry chain depth 0, auto-preflight idle,
tick last finished 12 s ago." Operators rely entirely on `console.log`
prefixes (`[tick]`, `[preflight-loop]`, `[auto-preflight]`,
`[booking-bridge]`, `[timing-learner]`). The Tools screen surfaces some of
this via individual `*-state.json` files but not a unified view.

---

## 6. Dead / vestigial code

### 6.1 `run-eligible-jobs-once.js`

Entry point behind `npm run scheduler:run`. Strongly suspected dead:

* uses an outdated `ELIGIBLE_PHASES = ['warmup', 'sniper']` (no `late`),
* skips every guard `tick.js` has accumulated (cooldown, auth-lock,
  classifier gate, already-booked, past-class, concurrency),
* directly calls `runBookingJob` with no `dryRun` consideration.

If it is used anywhere it is unsafe; if it is not used it should be deleted.
`run-scheduler-once.js` (which calls `runTick` directly) is the canonical
one-shot entry and is what `/run-scheduler-once` and the dashboard button
use.

### 6.2 Unused phase enum members

`booking-window.js`'s `late` phase is never produced as a normal user-flow
state — it is a fallback for "we missed the window," and `auto-preflight`
and `preflight-loop` both explicitly skip it. Only `tick.js` actually runs
in `late`. Confirm whether `late` should remain in the public phase enum or
be folded into `sniper` with a "still try" semantic.

### 6.3 `confirmingPhase` field on `executionTiming`

`execution-timing.js` L98 accepts a `confirmingPhase` option and only
surfaces it when `phase === 'confirming'`. Its only producer is
`server.js`'s `_sniperState?.confirmingPhase` read — a string written by
the bot during the post-click verification window. No consumer in the
client actually rotates banner copy from this field today (PlanScreen and
NowScreen read `executionTiming.phase === 'confirming'` and show a generic
label). Either wire the consumer (Task #60 work appears unfinished) or
remove the plumbing.

---

## 7. What is in good shape

Worth recording so a future refactor doesn't accidentally regress these:

* **`booking-window.js`** is the only correct implementation of the 3-day,
  1-hour-before-class math against Pacific time with DST handling. Every
  divergence noted above is a *consumer* of it that re-derives boundaries,
  not a divergence in the math itself.
* **`retry-strategy.js`** is a clean, side-effect-free function: failure
  taxonomy → execution-phase × failure-type lookup table → retry decision.
  This is a model for what the rest of the scheduler could look like.
* **`booking-bridge.js`** correctly hides the cross-module coupling
  between `preflight-loop` and `tick` behind a small interface.
* **`escalation.js` + `setEscalation/clearEscalation`** is the right
  pattern for surfacing a state that needs a human.

---

## 8. Prioritized follow-up tasks

These are written to be **non-overlapping** with the open queue (#63, #64,
#66, #68, #69, #70, #71, #72, #73, #75) and with each other. Each is
scoped to be reviewable in isolation.

| # | Title | Why now |
|---|---|---|
| **A** | **Persist auto-preflight's `firedThisCycle` gate** to disk (`auto-preflight-fired.json`, keyed by `${jobId}:${bookingOpenMs}:${triggerName}`) so a restart between T-30 and T-2 cannot double-fire a checkpoint. Trim entries older than `bookingOpen + 1 h`. | Direct fix for the most plausible cause of the "ghost preflight after restart" pattern observed during the Yoga Nidra disappear-cycle investigation. Small, contained, high reliability win. |
| **B** | **Centralize auth-block-stale constants and gate logic** into a single helper (`src/bot/auth-block-gate.js`) consumed by `tick.js`, `preflight-loop.js`, and `auto-preflight.js`. Export `isAuthBlocked({ now } = {})` returning `{ blocked, reason, minAgo, untilMs }`. | The three copies of the 20-min / 5-min logic *will* drift the next time anyone tweaks one. This is a pure refactor — no behavior change, fully covered by existing tick / auto-preflight tests. |
| **C** | **Add `isLocked()` re-check inside `triggerBookingFromBurst` and `scheduleHotRetry`** before each fire, and inside the hot-retry `setTimeout` callback at the moment of fire. Today only `runBurstCheck` checks the lock. | Closes the race in §5.4 where a hot-retry fires into a manual sign-in or session-keepalive that grabbed the auth lock between burst attempts. |
| **D** | **Filter past-class jobs in `auto-preflight.js` and `preflight-loop.js`** by calling `isPastClass(dbJob)` next to the existing `is_active === 1` filter. Stops both runners from computing phase / scheduling burst timers for one-off classes that ticked past their date+time between two `tick.js` runs. | Defense-in-depth around the past-class fix already merged in #65/#67. Minimal diff. |
| **E** | **Decide and execute on `run-eligible-jobs-once.js`**: confirm via `package.json` script usage and any docs whether `npm run scheduler:run` is actually invoked anywhere. If not, delete it. If yes, port it to call `runTick()` from `tick.js` so it inherits all guards. | Removes a known footgun (no-cooldown, no-auth-lock direct booking entry) and shrinks the surface area of "things that count as a runner." |
| **F** | **Extract a shared phase-derivation library** consumed by both `src/scheduler/booking-window.js` and a new `client/src/lib/bookingPhase.ts`, and replace `NowScreen.tsx`'s `computeBookingOpenMs` + `derivePhase` with imports from it. (Server can keep the JS file; client can re-export the same constants and a small TS wrapper around the API-supplied `bookingOpenMs`.) | Eliminates the silent client/server math drift identified in §3.3 — the highest-impact maintainability win because today every change to phase boundaries requires touching two languages and two files in lock-step. |

I propose all six as separate tasks. **A** and **B** are the only ones I'd
flag as worth running before any further sniper-engine feature work; C–F
are best treated as a "scheduler hygiene" batch that can run in parallel
once A and B are merged.

---

## 9. Out of scope

* **Yoga Nidra disappear-cycle root cause** — already owned by Task #68.
  The audit confirms #68's hypothesis (preflight ghost ID + multi-store
  drift) but does not duplicate the fix.
* **"At risk" badge noise / `schedule_not_loaded` backoff / Daxko 60 s
  retry** — owned by Tasks #69 / #70 / #71 respectively.
* **Non-booking surfaces (Account / Tools / Settings)** — owned by Task
  #75.
* **Fixing the booking-window math itself** — the math is correct, only
  its consumers are duplicated.
