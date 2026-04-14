// Stage 3 — First-attempt timing metrics
//
// Derives readable, comparable metrics from the raw timing markers recorded by
// Stage 2 in register-pilates.js (_tc / _state.timing).
//
// This module is a pure function — it takes a timing snapshot and returns a
// plain object of named metrics.  It never writes state itself; callers pass
// the result to recordTimingMetrics() in sniper-readiness.js.
//
// ── Metric definitions ────────────────────────────────────────────────────────
//
//   open_to_run_start         bookingOpenAt → run_start
//                             Negative = bot was already running when window opened.
//                             Null when bookingOpenAt is unknown (preflight, no schedule).
//
//   auth_phase_ms             session_ping_ms + browser_launch_ms
//                             Total wall-time spent on auth before page navigation.
//                             Excludes ping when ping was trusted (browser never launched).
//
//   run_start_to_page_ready   run_start → page_nav_done
//                             Everything before class discovery: auth + goto + dropdown wait.
//
//   page_ready_to_class_found page_nav_done → cardFoundAt  (or class_discovery_done fallback)
//                             How long it took to find the target class card after the page
//                             was ready.  Uses cardFoundAt when found in the initial scan;
//                             falls back to class_discovery_done (end of initial scan, card
//                             not found yet — will enter poll mode).
//
//   class_found_to_first_click cardFoundAt → modal_open_start
//                             Scroll + click latency from card visible to click fired.
//                             Null when card was not found in the initial scan.
//
//   modal_open_ms             modal_open_start → modal_open_done
//                             How long it took for the booking modal to render its buttons.
//
//   first_click_to_confirmation actionClickAt → confirmation_check_done
//                             Time from the Register/Waitlist click to receiving a
//                             confirmation (or non-confirmation) result.
//
//   open_to_confirmation      bookingOpenAt → confirmation_check_done
//                             End-to-end latency from window-open to final answer.
//                             The headline SLA metric for booking performance.
//
//   total_first_attempt_ms    first_click_attempt_start → first_click_attempt_done
//                             Wall-time of the entire first action-loop attempt.
//
//   slowest_phase             Name of the phase with the highest ms value
//                             among the named phase durations above.
//
// All values are in milliseconds (integers).  A null value means one or both
// endpoints were not reached in this run (e.g. auth failed before nav).
//
// Log prefix: [timing-metrics]

'use strict';

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Compute ms between two ISO strings.  Returns null if either is falsy.
 * The result may be negative (b occurred before a) — that is intentional
 * for open_to_run_start where a negative means the bot was ready early.
 */
function delta(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Derive first-attempt metrics from a Stage 2 timing snapshot.
 *
 * @param {object} t  The timing object stored at _state.timing (may be null).
 * @returns {{
 *   open_to_run_start:          number|null,
 *   auth_phase_ms:              number|null,
 *   run_start_to_page_ready:    number|null,
 *   page_ready_to_class_found:  number|null,
 *   class_found_to_first_click: number|null,
 *   modal_open_ms:              number|null,
 *   first_click_to_confirmation:number|null,
 *   open_to_confirmation:       number|null,
 *   total_first_attempt_ms:     number|null,
 *   slowest_phase:              string|null,
 * } | null}  null when timing data is absent or contains no run_start.
 */
function deriveTimingMetrics(t) {
  if (!t || !t.run_start) return null;

  // ── Named phase durations ───────────────────────────────────────────────────

  // How early/late the bot started relative to the booking window open.
  // Negative = bot was already in flight; positive = bot started after open.
  const open_to_run_start = delta(t.bookingOpenAt, t.run_start);

  // Total auth wall-time: ping + browser launch (either or both may be null
  // when the ping was trusted and no browser auth was needed).
  const _ping    = t.session_ping_ms    ?? null;
  const _launch  = t.browser_launch_ms  ?? null;
  const auth_phase_ms = (_ping !== null || _launch !== null)
    ? ((_ping ?? 0) + (_launch ?? 0))
    : null;

  // Everything from run_start until the page and dropdowns are ready.
  const run_start_to_page_ready = delta(t.run_start, t.page_nav_done);

  // Class discovery: use cardFoundAt when the card was found in the initial
  // scan; fall back to class_discovery_done (scan finished, card not yet found).
  const _discoveryEnd = t.cardFoundAt || t.class_discovery_done;
  const page_ready_to_class_found = delta(t.page_nav_done, _discoveryEnd);

  // Time from card visible to the moment the click on the card was fired.
  // modal_open_start is set immediately before attemptClickAndVerify() is
  // called, which is the cleanest proxy for "we are about to click".
  const class_found_to_first_click = delta(t.cardFoundAt, t.modal_open_start);

  // How long the modal took to render its action buttons.
  const modal_open_ms = delta(t.modal_open_start, t.modal_open_done);

  // Time from the Register/Waitlist click to confirmation result.
  const first_click_to_confirmation = delta(t.actionClickAt, t.confirmation_check_done);

  // End-to-end: booking window opened → confirmation received.
  const open_to_confirmation = delta(t.bookingOpenAt, t.confirmation_check_done);

  // Total first-attempt wall-time (entire first action-loop iteration).
  const total_first_attempt_ms = delta(
    t.first_click_attempt_start,
    t.first_click_attempt_done
  );

  // ── Slowest named phase ─────────────────────────────────────────────────────
  // Exclude open_to_run_start (directional, may be negative) and
  // open_to_confirmation (composite, not a single phase).
  const phaseMap = {
    auth:         auth_phase_ms,
    page_load:    run_start_to_page_ready,
    class_find:   page_ready_to_class_found,
    card_to_click: class_found_to_first_click,
    modal_open:   modal_open_ms,
    confirmation: first_click_to_confirmation,
    first_attempt: total_first_attempt_ms,
  };

  let slowest_phase = null;
  let slowestMs = -Infinity;
  for (const [name, ms] of Object.entries(phaseMap)) {
    if (ms !== null && ms > slowestMs) {
      slowestMs    = ms;
      slowest_phase = name;
    }
  }
  if (slowest_phase === null) slowest_phase = null; // keep explicit

  return {
    open_to_run_start,
    auth_phase_ms,
    run_start_to_page_ready,
    page_ready_to_class_found,
    class_found_to_first_click,
    modal_open_ms,
    first_click_to_confirmation,
    open_to_confirmation,
    total_first_attempt_ms,
    slowest_phase,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { deriveTimingMetrics };
