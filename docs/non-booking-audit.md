# Non-Booking Surfaces Audit (Task #75)

Discovery-only audit of every non-booking server endpoint, every non-Now/Plan
client surface, and every persistence path that could drift across SQLite,
PostgreSQL, and JSON files. Booking-window and preflight code are explicitly
out of scope (covered by tasks #68–#71).

No production code is changed by this task. The output is this document plus
a prioritized follow-up list at the bottom.

---

## 1. Server endpoint error contracts

Grading rubric:

- **Good** — non-2xx status with a human-readable `error`/`message` field, *or*
  a 200 envelope whose `success:false` carries a usable `detail` string.
- **Misleading** — returns 200 with no indication of failure, or surfaces an
  opaque message (`"Internal error"`, empty body, raw `err.stack`).
- **Silent** — silently substitutes a default value when the underlying read
  fails or input is missing, so the caller cannot tell anything went wrong.

### System / state

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/status` | GET | Good | Always 200, returns in-memory `jobState`. |
| `/api/state` | GET | **Silent** | Always 200. Calls `inactivatePastJobs()` as a side effect — past one-off jobs are flipped to inactive without telling the caller. |
| `/api/sniper-state` | GET | **Silent** | If `sniper-state.json` is missing/unreadable, returns a hardcoded empty default with no error flag. |
| `/api/readiness` | GET | **Silent** | If the readiness state has no jobId, silently falls back to "first active job in DB". UI can't distinguish "explicitly tracked" from "fallback". |
| `/api/confirmed-ready` | GET | **Silent** | Same fallback to first active job when `?jobId` is missing/invalid. |

### Jobs read endpoints (booking-job mutations are out of scope; reads aren't)

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/jobs` | GET | **Silent** | Always 200. Same `inactivatePastJobs()` side effect as `/api/state`; the response is enriched with a `passed` flag but the act of mutating rows is not surfaced. |
| `/api/jobs/:id/classify` | GET | Good | Returns 400 with `{error:'Invalid job ID'}` and 404 with `{error:'Job not found'}`. Cache-only — no fallback synthesis. |

### Replay history

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/replay-history/:jobId` | GET | Good | 400 + `{error:'Missing jobId'}` when path is empty; otherwise returns whatever `replayStore.getReplayList` produces (empty array is honest). |
| `/api/replay/:jobId(/:runId)` | GET | Good | 400 on missing jobId, 404 + `{error:'No replay found'}` when not found. The underlying store is local-only / lost on deploy (see §3). |

### Diagnostic helpers

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/dry-run` | POST | **Misleading** | Always returns 200. On thrown exception emits `{success:false, status:'error', message: err.message, label:'Run failed'}` — the *raw* `err.message` is shown to the user, which can leak stack-style strings. Job-not-found is reported as `{success:false, message:'Job not found'}` instead of a 404. |
| `/run-job` | GET | **Misleading** | Always 200. "Job not found" returned as `{started:false, log: 'No job found...'}` with no status code. Treats a busy bot as a successful no-op (`{started:false, log:'Already running…'}`). |
| `/clean-test-jobs` | GET | **Misleading** | Destructive (deletes rows) but exposed as a GET, so any link prefetch can fire it. Always 200; no auth check. |
| `/register` | GET | Good | Trivial helper — kicks off `runInBackground` for job 1; returns `{started:true}`. Same "always 200" pattern as `/run-job` but documented as a developer-only entry point. |

### Failures / screenshots

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/failures` | GET | **Silent** | If the SQLite `failures` table is empty, scans `screenshots/` directory and synthesizes legacy entries — caller cannot tell whether they are real DB rows or filesystem artifacts. |
| `/api/failures` | DELETE | Good | 200 + writes `failures-cleared.json` flag to suppress legacy fallback. |
| `/api/screenshots/:rel` | GET | **Misleading** | 403 / 404 with empty body. No JSON, no message. |
| `/screenshots/:file` | GET | **Misleading** | Same — empty 404. |

### Settings / auth / session

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/session-status` | GET | **Silent** | If `session-status.json` is missing, defaults `detail`/`screenshot` to `null`. UI can't tell "never checked" from "file disappeared". |
| `/api/session-check` | POST | Good | Returns `valid: null` + human `detail` when busy/locked. |
| `/api/settings-login` | POST | Good | `success:false` + readable `detail`. |
| `/api/settings-refresh` | POST | Good | Same. |
| `/api/validate-session` | POST | Good | Same. |
| `/api/settings-clear` | POST | **Silent** | On filesystem error returns `success:false` with `detail`, but **preserves `events` in `sniper-state.json` while wiping `bundle.session`** — leaves the file in a half-cleared state without surfacing that. |

### Automation / config

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/auto-preflight-config` | GET | Good | |
| `/api/auto-preflight-config` | POST | Good | Returns `success:false` + `message` on bad body. |
| `/api/session-keepalive-config` | GET | Good | |
| `/api/session-keepalive-config` | POST | **Silent** | If `intervalMinutes` missing, falls back to `intervalHours * 60`, then to a hardcoded 12 minutes — no warning that the requested interval was not honored. |
| `/pause-scheduler`, `/resume-scheduler`, `/set-dry-run` | POST | Good | Trivial 200 + `success:true`. |

### Scraper / schedule

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/scraped-classes` | GET | Good | Returns whatever was last scraped; no synthesis. |
| `/refresh-schedule` | POST | Good | 409 (already running) and 500 (scrape failed) both carry an `error` string. |

### Recovery tools

| Endpoint | Method | Grade | Notes |
|---|---|---|---|
| `/api/recovery/reset-job-state` | POST | Good | |
| `/api/recovery/resync-pg` | POST | Good | |
| `/api/recovery/clear-transient` | POST | Good | 400 + readable `message` if `confirm:true` not passed. |

**Headline:** the highest-volume read endpoints (`/api/state`,
`/api/sniper-state`, `/api/readiness`, `/api/confirmed-ready`,
`/api/session-status`, `/api/failures`) are also the worst offenders for
silent fallbacks. Every one of them can return a "valid-looking" response
in a degraded state.

---

## 2. Client silent fallbacks & stale-data risks

### 2a. Silent fallbacks (default value masks missing/changed payload)

- `ToolsScreen.tsx:1248` — `RESULT_LABELS[lastRunJob.last_result] ?? lastRunJob.last_result`. If the server emits a new `last_result` enum, the user sees the raw enum string instead of a translated label, with no indication a release is needed.
- `ToolsScreen.tsx:1373` — `jobs.find(j => j.id === selectedJobId) ?? null`. If a selected job is deleted between renders the panel silently empties; no toast, no "job removed".
- `ToolsScreen.tsx:1666` — Failure Insights list shows raw `r.reason` if the label map is missing the key.
- `ToolsScreen.tsx:291,513,555,691,751` — Phase / evidence label maps all fall back to raw keys.
- `AccountSheet.tsx:142` — `subline: '—'` when `authState` is missing from the API response.
- `AccountSheet.tsx:475` — `'Not yet checked'` shown when both `lastCheckedAt` and `lastVerified` are null (cannot distinguish "never run" from "API didn't return the field at all").
- `AccountSheet.tsx:505–512` — `auth?.daxkoValid ?? null` propagates a missing `auth` object as a dash.

### 2b. Empty / no-op catch blocks

- `ToolsScreen.tsx:1530` — `handleAutoPreflightToggle` swallows errors. Toggle silently snaps back; user thinks server rejected it.
- `ToolsScreen.tsx:1540` — `handleKeepaliveToggle` same pattern.
- `ToolsScreen.tsx:1562` — `handleClearFailures` swallows errors; user can't tell their history wasn't cleared.
- `SettingsScreen.tsx:28` — `handleDryRun` swallows errors; toggle desyncs from server.
- `SettingsScreen.tsx:36` — `handlePauseResume` same.
- `AccountSheet.tsx:232` — `fetchSession` `.catch(() => setSession(null))` reverts to "Checking…" with no error message.

### 2c. Stale data without freshness indicator

- **Tools tab as a whole** — `failures`, `readiness` and `appState` are
  cached on the client. If background polling fails the screen continues
  showing the last known values with no banner, no greyed-out state, and no
  "last synced" timestamp. The same is true of the Settings status card
  (`SettingsScreen.tsx:84–86`).
- **AccountSheet "Checked X min ago"** — the timestamp is the *backend's*
  last verification, not the *frontend's* last successful sync. If the
  client loses connectivity the value freezes but never says so.

---

## 3. Cross-store drift outside booking jobs

| Surface | Primary store | Sync | Drift risk |
|---|---|---|---|
| Failure log | SQLite `failures` table | **None** (no PG mirror) | All failure history is wiped on every container recycle / publish, even though the dashboard treats it as durable. |
| Auth canonical truth | `data/auth-state.json` | **None** | Mid-migration: `register-pilates.js` and `session-check.js` write to both `auth-state.json` and the legacy `session-status.json`. `readiness-state.js` and `scheduler/tick.js` still read the legacy file → `auth-state.json` can be newer than what the scheduler sees. |
| Sniper state | `data/sniper-state.json` | **None** | Read-modify-write with no cross-process lock. Concurrent writers (preflight loop + manual UI trigger) can clobber each other's events. `fs.writeFileSync` is not atomic — a crash mid-write truncates the JSON. |
| Auto-preflight log | `data/auto-preflight-log.json` | **None** | Same read-array / push / write-array pattern; same atomicity risk. Grows unbounded. |
| Schedule cache | `src/classifier/scheduleCache.json` | **None** | Local only. Restart loses the cache; only signal to the user that the schedule is stale is implicit (slow first scrape). |
| Replay store | `data/replays/job-N/*.json` | **None** | Local only; lost on deployment. Tools UI surfaces these as if durable. |

**Headline drift bug:** `auth-state.json` (canonical) vs `session-status.json`
(legacy) can disagree, and the scheduler still reads the legacy file. This is
a structural reproduction risk for "session looked OK in the UI but the bot
ran with stale auth".

---

## 4. Prioritized follow-up tasks

These are **non-overlapping** with the existing pending tasks (Now-screen
verified outcome, ambiguous-outcome failure log, weekly-suggestion reset,
weekly-suggestion pre-lapse, double-firing checkpoints, server/UI booking
timing drift, session-failure backoff consistency).

Each is one shippable change.

### P0 — `auth-state.json` is the single source of truth (kill the legacy read path)

**Problem.** `scheduler/tick.js` and `bot/readiness-state.js` still read
`session-status.json` while `bot/session-check.js` writes to both files.
The two files can disagree, so the scheduler can arm a run on stale auth
even though the UI thinks the session is fresh.

**Done looks like.** Every reader in `src/` is migrated to the
`auth-state.js` accessor. `session-status.json` is written for compatibility
only and is no longer read by production code. A unit test fails if a new
direct read of `session-status.json` is introduced.

### P1 — Atomic JSON writes for `sniper-state.json` and `auto-preflight-log.json`

**Problem.** Both files use plain `fs.writeFileSync(path, JSON.stringify(...))`.
A crash mid-write produces truncated JSON; the next read either throws or
trips the silent default in `/api/sniper-state`.

**Done looks like.** A small `writeJsonAtomic(path, data)` helper that writes
to `path.tmp` and `fs.renameSync` into place. All non-job JSON writers use it.
A test simulates a partial write and verifies the readers still see the
previous good copy.

### P2 — `/api/state`, `/api/sniper-state`, `/api/readiness`, `/api/session-status` declare degraded mode

**Problem.** These four endpoints all return a "valid-looking" 200 in
several degraded states (file missing, jobId fallback, `inactivatePastJobs`
side effect). The client cannot tell "true" from "best-effort".

**Done looks like.** Each response gains a small `meta` block — at minimum
`{ degradedReason: string|null, fallbackJobId: boolean, snapshotAge: number|null }`.
Tools and Account screens render a "Showing last known state" badge when
any of them is set. No behavior change beyond the badge.

### P3 — Failure log durability (or honest UI label)

**Problem.** The failure log is SQLite-only and is wiped on every
container recycle. The Failure Insights panel and trend windows present it
as durable history.

**Done looks like.** Either (a) mirror failure rows into PG via the same
`pg-sync` channel used for jobs, or (b) keep SQLite-only and surface a
"History resets on restart — last reset Apr 18 11:02" line at the top of
the Failure Insights panel. Either is shippable in isolation; pick one.

### P4 — Surface client action errors in Tools / Settings toggles

**Problem.** Six handlers (`handleAutoPreflightToggle`, `handleKeepaliveToggle`,
`handleClearFailures`, `handleDryRun`, `handlePauseResume`,
`AccountSheet.fetchSession`) swallow errors. Toggles snap back silently;
the "Clear failure history" button reports nothing on failure.

**Done looks like.** A shared `useToggleAction` (or equivalent) that on
rejection (a) keeps the local state flipped back, (b) shows an inline
"Couldn't reach server — try again" message under the row for ~4 s, and
(c) leaves the toggle interactive. AccountSheet shows an explicit "Couldn't
load session — tap to retry" instead of reverting to "Checking…".

### P5 — Tools / Settings staleness banner when polling fails

**Problem.** When the background `refresh()` cycle fails, Tools and
Settings show last-known data forever with no indication. Combined with
P2's `meta.snapshotAge`, the user has no signal that what they see is old.

**Done looks like.** A small "Last synced 2 m ago — retrying" pill in the
header of Tools and Settings whenever the most recent poll error-ed or the
snapshot is older than a threshold. No new endpoints; reuses existing poll
state.

---

## 5. Appendix — every route in `src/web/server.js`

Completeness check: each route defined in `src/web/server.js` is listed
below with its in-scope decision. In-scope rows are graded above.

| Route | Method | In scope? | Reason |
|---|---|---|---|
| `/` | GET | No | Static HTML / SPA shell. |
| `/sw.js` | GET | No | Service worker bundle (PWA). |
| `/manifest.json` | GET | No | PWA manifest. |
| `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png` | GET | No | Generated PWA icons. |
| `/status` | GET | Yes | Diagnostic. |
| `/register` | GET | Yes | Diagnostic helper. |
| `/force-run-job` | POST | No | Booking surface (#68–#71). |
| `/api/preflight` | POST | No | Booking surface. |
| `/api/dry-run` | POST | Yes | Diagnostic helper that runs the booking pipeline in dry-run mode but is reachable from non-booking UI. |
| `/api/session-status` | GET | Yes | Auth/session. |
| `/api/session-check` | POST | Yes | Auth/session. |
| `/api/settings-login` | POST | Yes | Settings/auth. |
| `/api/settings-refresh` | POST | Yes | Settings/auth. |
| `/api/validate-session` | POST | Yes | Auth/session. |
| `/api/settings-clear` | POST | Yes | Settings/auth. |
| `/api/auto-preflight-config` | GET / POST | Yes | Automation config. |
| `/api/session-keepalive-config` | GET / POST | Yes | Automation config. |
| `/run-job` | GET | Yes | Diagnostic helper. |
| `/clean-test-jobs` | GET | Yes | Destructive diagnostic. |
| `/update-job` | POST | No | Booking-job mutation. |
| `/toggle-active` | POST | No | Booking-job mutation. |
| `/api/jobs/:id/advance` | POST | No | Booking-job mutation. |
| `/api/jobs/:id/convert-to-recurring` | POST | No | Booking-job mutation. |
| `/api/jobs/:id/dismiss-weekly-suggestion` | POST | No | Booking-job mutation. |
| `/delete-job` | POST | No | Booking-job mutation. |
| `/reset-booking` | POST | No | Booking surface. |
| `/clear-escalation` | POST | No | Booking surface. |
| `/cancel-registration` | POST | No | Booking surface. |
| `/add-job` | POST | No | Booking-job mutation. |
| `/run-scheduler-once` | POST | No | Booking surface. |
| `/run-selected-scheduler` | POST | No | Booking surface. |
| `/pause-scheduler` | POST | Yes | Scheduler global. |
| `/resume-scheduler` | POST | Yes | Scheduler global. |
| `/set-dry-run` | POST | Yes | Scheduler global. |
| `/api/jobs` | GET | Yes | Read endpoint with side effects. |
| `/api/jobs/:id/classify` | GET | Yes | Read endpoint. |
| `/api/state` | GET | Yes | Dashboard read. |
| `/api/sniper-state` | GET | Yes | Read endpoint. |
| `/api/readiness` | GET | Yes | Read endpoint. |
| `/api/confirmed-ready` | GET | Yes | Read endpoint. |
| `/api/failures` | GET / DELETE | Yes | Failure log. |
| `/api/replay-history/:jobId` | GET | Yes | Replay history. |
| `/api/replay/:jobId(/:runId)` | GET | Yes | Replay history. |
| `/api/scraped-classes` | GET | Yes | Schedule scrape. |
| `/refresh-schedule` | POST | Yes | Schedule scrape. |
| `/api/screenshots/:rel` | GET | Yes | Screenshot serving. |
| `/screenshots/:file` | GET | Yes | Legacy screenshot serving. |
| `* (SPA fallback)` | GET | No | React index.html catch-all when `dist/` is built. |
| `/api/recovery/reset-job-state` | POST | Yes | Recovery tool. |
| `/api/recovery/resync-pg` | POST | Yes | Recovery tool. |
| `/api/recovery/clear-transient` | POST | Yes | Recovery tool. |

---

## 6. What this audit deliberately did not cover

- Anything inside the Now / Plan / preflight surface (tasks #68–#71).
- The scheduler/phase model itself (separate audit).
- The Daxko / FamilyWorks browser session internals (only their persisted
  output files).
- Performance / log-volume of the various JSON writers.
