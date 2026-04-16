// Stage 10G — Booking bridge
// Stage 10I — Hot retry on transient failure
//
// Thin shared-state module that lets the preflight-loop burst trigger a real
// booking run (via the same runTick path used by the scheduler) while keeping
// server.js's jobState flag accurate.
//
// Stage 10G: direct handoff — burst detects ACTION_READY → runTick immediately,
//   bypassing the up-to-60s scheduler tick delay.
//
// Stage 10I: hot-retry callback — after a transient failure at window open
//   (found_not_open_yet or error), invoke onRetry() so the caller can schedule
//   a rapid re-attempt rather than waiting through the 5-min cooldown.
//   skipCooldown: true is passed on hot-retry invocations.
//
// Log prefix: [booking-bridge]

'use strict';

const { runTick } = require('./tick');

// ── Bridge state ──────────────────────────────────────────────────────────────

let _isActive  = () => false;   // () => boolean — reads jobState.active
let _setActive = () => {};      // (v: boolean) => void — writes jobState.active

/**
 * Called once by server.js at start-up to wire the bridge into jobState.
 *
 * @param {{ isActive: () => boolean, setActive: (v: boolean) => void }} cbs
 */
function setBridgeCallbacks({ isActive, setActive }) {
  _isActive  = isActive;
  _setActive = setActive;
}

// ── Hot-retry helpers ─────────────────────────────────────────────────────────

// Statuses that warrant a hot retry (transient race conditions at window open).
// 'found_not_open_yet' : burst saw ACTION_READY but booking opened before browser
//                        finished loading — very common at exact window open.
// 'error'              : generic transient failure (network, browser crash, etc.)
const HOT_RETRYABLE = new Set(['found_not_open_yet', 'error']);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Trigger a full booking run for the given jobId, using the same runTick()
 * path as the scheduler.  Called by the burst when it detects ACTION_READY.
 *
 * Refuses to fire if a booking is already active (concurrency guard).
 * Returns a Promise (fire-and-forget at the call site; caller attaches .catch).
 *
 * @param {number} jobId
 * @param {{
 *   skipCooldown?: boolean,       Stage 10I — bypass tick cooldown on hot retry
 *   onRetry?:      (status: string) => void,   Stage 10I — called on retryable failure
 * }} [opts]
 */
async function triggerBookingFromBurst(jobId, { skipCooldown = false, onRetry = null } = {}) {
  if (_isActive()) {
    console.log(
      `[booking-bridge] skip — Job #${jobId} booking already active; ` +
      `${skipCooldown ? 'hot-retry' : 'burst-to-booking handoff'} cancelled.`
    );
    return;
  }

  const label = skipCooldown ? 'hot-retry' : 'burst handoff';
  console.log(
    `[booking-bridge] ${label} — Job #${jobId} ` +
    `${skipCooldown ? 'retrying after transient failure' : 'burst detected ACTION_READY'}; ` +
    `firing booking run via tick.`
  );

  _setActive(true);
  try {
    const results = await runTick({ onlyJobId: Number(jobId), skipCooldown });
    const r = results.find(x => x.jobId === Number(jobId));
    console.log(
      `[booking-bridge] done — Job #${jobId} tick finished: ` +
      `status=${r?.status ?? 'no-result'} msg="${r?.message ?? ''}".`
    );

    // Stage 10I — invoke hot retry callback on retryable transient failure.
    if (r && HOT_RETRYABLE.has(r.status) && onRetry) {
      console.log(
        `[booking-bridge] hot-retry:trigger — Job #${jobId} ` +
        `status="${r.status}" is retryable; invoking onRetry callback.`
      );
      onRetry(r.status);
    }
  } catch (err) {
    console.error(`[booking-bridge] error — Job #${jobId}:`, err.message);
    // Treat caught errors as retryable too if a callback is registered.
    if (onRetry) onRetry('error');
  } finally {
    _setActive(false);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

// Stage 11.2 — read-only probe so callers (preflight-loop's immediate-trigger
// gate) can pre-decide without racing into triggerBookingFromBurst().  This
// reads the same callback as the internal guard inside the helper above, so
// the two never disagree.
function isBookingActive() {
  try { return !!_isActive(); } catch (_) { return false; }
}

module.exports = { setBridgeCallbacks, triggerBookingFromBurst, isBookingActive };
