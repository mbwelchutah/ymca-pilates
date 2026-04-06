// Stage 10G — Booking bridge
//
// Thin shared-state module that lets the preflight-loop burst trigger a real
// booking run (via the same runTick path used by the scheduler) while keeping
// server.js's jobState flag accurate.
//
// The bridge is deliberately minimal:
//   - server.js calls setBridgeCallbacks() once at start-up, supplying two
//     functions that read/write its private jobState.
//   - preflight-loop.js calls triggerBookingFromBurst() when the burst detects
//     ACTION_READY.  The bridge delegates to runTick (same path as the
//     scheduler) and wraps the call with jobState signalling.
//
// Why not just call runTick() directly from the burst?
//   runTick does NOT update jobState.active.  That flag is maintained by
//   server.js (originally only for manual /force-run-job requests).
//   Stage 10E reads isConfirming from jobState.active, so it must be set
//   whenever any booking run is in flight — including burst-triggered ones.
//
// Concurrency: triggerBookingFromBurst() refuses to fire if isJobActive()
// returns true, so a burst can never double-launch over a running tick.
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Trigger a full booking run for the given jobId, using the same runTick()
 * path as the scheduler.  Called by the burst when it detects ACTION_READY.
 *
 * Refuses to fire if a booking is already active (concurrency guard).
 * Returns immediately (fire-and-forget); the Promise is returned for the
 * caller to attach error handlers.
 *
 * @param {number} jobId
 * @returns {Promise<void>}
 */
async function triggerBookingFromBurst(jobId) {
  if (_isActive()) {
    console.log(
      `[booking-bridge] skip — Job #${jobId} booking already active; ` +
      `burst-to-booking handoff cancelled.`
    );
    return;
  }

  console.log(
    `[booking-bridge] handoff — Job #${jobId} burst detected ACTION_READY; ` +
    `firing booking run via tick (bypassing up-to-60s tick delay).`
  );

  _setActive(true);
  try {
    const results = await runTick({ onlyJobId: Number(jobId) });
    const r = results.find(x => x.jobId === Number(jobId));
    console.log(
      `[booking-bridge] done — Job #${jobId} tick finished: ` +
      `status=${r?.status ?? 'no-result'} msg="${r?.message ?? ''}".`
    );
  } catch (err) {
    console.error(`[booking-bridge] error — Job #${jobId}:`, err.message);
  } finally {
    _setActive(false);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { setBridgeCallbacks, triggerBookingFromBurst };
