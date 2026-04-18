'use strict';

/**
 * Self-Healing / Safe Recovery Pass — Stage 2
 *
 * PURE STATE MODEL ONLY. No I/O, no DOM access, no control flow.
 * Nothing in this file is wired into the booking pipeline yet —
 * later stages will read from these constants at decision points.
 *
 * The model exists so that every recovery decision can be expressed as
 *
 *     "given (PageHealth, DomTrust, Evidence), is it safe to click Register?"
 *
 * with a single source of truth, instead of being scattered across
 * register-pilates.js as ad-hoc booleans.
 */

// ---------------------------------------------------------------------------
// DomTrust — how much we trust that the DOM target in front of us is the
// actual target class. This is the gate that real Register clicks must pass.
// ---------------------------------------------------------------------------
const DOM_TRUST = Object.freeze({
  TRUSTED:   'trusted',    // strong identity proof (see EVIDENCE.STRONG_*)
  UNKNOWN:   'unknown',    // no strong proof yet, but nothing clearly broken
  UNTRUSTED: 'untrusted',  // active red flag (filters failed, wrong modal,
                           // stale DOM after rerender, etc.)
});

// ---------------------------------------------------------------------------
// PageHealth — what kind of trouble (if any) the page is in right now.
// Drives which recovery layer (stages 3-5) is appropriate.
// ---------------------------------------------------------------------------
const PAGE_HEALTH = Object.freeze({
  HEALTHY:            'healthy',
  FILTERS_FAILED:     'filters_failed',     // stage 6 containment
  TRANSIENT_EMPTY:    'transient_empty',    // stage 3 page reset
  STALE_DOM:          'stale_dom',          // stage 4 re-target
  WRONG_MODAL:        'wrong_modal',        // stage 5 modal containment
  ACTION_UNAVAILABLE: 'action_unavailable', // modal open, no Register button
  AUTH_BLOCKED:       'auth_blocked',       // session expired mid-run
});

// ---------------------------------------------------------------------------
// Evidence kinds — these are the *only* things that can promote DomTrust to
// TRUSTED. Listed exhaustively so later stages can never accidentally invent
// a weaker proof.
// ---------------------------------------------------------------------------
const EVIDENCE = Object.freeze({
  // Strong (any one of these, when fresh, may yield TRUSTED)
  STRONG_EXACT_ROW:        'exact_row_match',          // findCardOnTab returned
                                                       //   a card whose
                                                       //   title/time/instructor
                                                       //   all matched
  STRONG_MODAL_VERIFIED:   'modal_title_and_time_ok',  // modal text contains
                                                       //   target title AND
                                                       //   target time
  STRONG_TITLE_TIME_INSTR: 'title_time_instructor_ok', // all three aligned
                                                       //   on the row before
                                                       //   click

  // Weak / informational only (must NOT promote to TRUSTED on its own)
  WEAK_TIME_ONLY:          'time_only_match',
  WEAK_FUZZY_TITLE:        'fuzzy_title_match',
  WEAK_LIVE_TRUTH_OPEN:    'live_truth_says_open',
});

const STRONG_EVIDENCE = new Set([
  EVIDENCE.STRONG_EXACT_ROW,
  EVIDENCE.STRONG_MODAL_VERIFIED,
  EVIDENCE.STRONG_TITLE_TIME_INSTR,
]);

// ---------------------------------------------------------------------------
// emptyTrustState() — canonical zero value. Use as the starting point for
// any per-run trust ledger so every field is always present.
// ---------------------------------------------------------------------------
function emptyTrustState() {
  return {
    domTrust:   DOM_TRUST.UNKNOWN,
    pageHealth: PAGE_HEALTH.HEALTHY,
    evidence:   [],          // array of EVIDENCE.* values gathered this run
    notes:      [],          // free-form short strings for diagnostics
    healAttempts: {          // bounded counters for stages 3-5
      pageReset:    0,
      staleRetarget: 0,
      wrongModalRetry: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// hasStrongEvidence(state) — pure helper. True iff the trust ledger contains
// at least one strong evidence kind. Later stages use this to decide whether
// liveTruth OPEN may accelerate booking.
// ---------------------------------------------------------------------------
function hasStrongEvidence(state) {
  if (!state || !Array.isArray(state.evidence)) return false;
  for (const e of state.evidence) {
    if (STRONG_EVIDENCE.has(e)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// classifyDomTrust(state) — derives DomTrust from PageHealth + Evidence using
// fixed rules. Pure function. Does not mutate.
//
//   - WRONG_MODAL or STALE_DOM with no strong evidence       => UNTRUSTED
//   - FILTERS_FAILED with no strong evidence                 => UNTRUSTED
//     (filters failed but a strong exact row/modal can still rescue trust)
//   - AUTH_BLOCKED                                           => UNTRUSTED
//   - TRANSIENT_EMPTY / ACTION_UNAVAILABLE without evidence  => UNKNOWN
//   - HEALTHY + strong evidence                              => TRUSTED
//   - HEALTHY without strong evidence                        => UNKNOWN
// ---------------------------------------------------------------------------
function classifyDomTrust(state) {
  if (!state) return DOM_TRUST.UNKNOWN;
  const ph     = state.pageHealth || PAGE_HEALTH.HEALTHY;
  const strong = hasStrongEvidence(state);

  if (ph === PAGE_HEALTH.AUTH_BLOCKED)  return DOM_TRUST.UNTRUSTED;
  if (ph === PAGE_HEALTH.WRONG_MODAL)   return DOM_TRUST.UNTRUSTED;
  if (ph === PAGE_HEALTH.STALE_DOM && !strong) return DOM_TRUST.UNTRUSTED;
  if (ph === PAGE_HEALTH.FILTERS_FAILED && !strong) return DOM_TRUST.UNTRUSTED;

  if (ph === PAGE_HEALTH.TRANSIENT_EMPTY)    return DOM_TRUST.UNKNOWN;
  if (ph === PAGE_HEALTH.ACTION_UNAVAILABLE) return DOM_TRUST.UNKNOWN;

  if (ph === PAGE_HEALTH.HEALTHY && strong) return DOM_TRUST.TRUSTED;
  return DOM_TRUST.UNKNOWN;
}

// ---------------------------------------------------------------------------
// isSafeToBook(state) — single chokepoint that real booking triggers will
// consult in later stages. Pure. Returns { ok, reason }.
// ---------------------------------------------------------------------------
function isSafeToBook(state) {
  const trust = classifyDomTrust(state);
  if (trust === DOM_TRUST.TRUSTED) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `dom_trust=${trust} pageHealth=${state?.pageHealth || 'unknown'}`,
  };
}

module.exports = {
  DOM_TRUST,
  PAGE_HEALTH,
  EVIDENCE,
  STRONG_EVIDENCE,
  emptyTrustState,
  hasStrongEvidence,
  classifyDomTrust,
  isSafeToBook,
};
