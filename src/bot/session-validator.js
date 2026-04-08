// Stage 9 — Tier Escalation Engine
//
// validateSessionFastThenFallback() chooses the cheapest validation path that
// is safe for the current context, escalating only when needed.
//
// Escalation order (each tier is attempted only if the previous one fails or
// is deemed insufficient):
//
//   Tier 1 — File freshness (sub-ms)
//     Both session files exist, are marked valid, and were written within the
//     last TRUST_THRESHOLD_MIN (30 min).  Fast and silent.
//
//     Suspicion override: if data is older than SUSPICION_AGE_MIN (20 min, 67%
//     of the threshold) Tier-1 passes technically but is treated as suspicious —
//     escalated to Tier 2 for an HTTP double-check.
//
//   Tier 2 — HTTP ping (1–5 s)
//     Uses saved browser cookies to make real authenticated requests to Daxko
//     and FamilyWorks without launching a browser.
//
//   Tier 3 — Full Playwright login (~30 s)
//     Authoritative — runs the full Playwright session check.  Always used
//     when Tier 2 is inconclusive or when strict mode requires it.
//
// Strict mode — enforced automatically near the booking window:
//   too_early (> 10 min to open) → minTier = 1  (normal escalation)
//   warmup    (10–1 min to open) → minTier = 2  (HTTP ping required)
//   sniper    (< 1 min to open)  → minTier = 3  (Playwright required)
//   late      (window passed)    → minTier = 3  (Playwright required)
//
// forceMinTier option lets callers override the computed minimum (useful for
// the manual "Refresh connection" button, testing, or preflight hooks).

'use strict';

const fs   = require('fs');
const path = require('path');

const { checkFreshness }                  = require('../scheduler/session-keepalive');
const { pingSessionHttp }                 = require('./session-ping');
const { runSessionCheck, loadStatus }     = require('./session-check');
const { getPhase }                        = require('../scheduler/booking-window');
const { getAllJobs }                       = require('../db/jobs');

const DATA_DIR = path.resolve(__dirname, '../data');
const FW_FILE  = path.join(DATA_DIR, 'familyworks-session.json');

// ── Constants ─────────────────────────────────────────────────────────────────

const TRUST_THRESHOLD_MIN = 30;   // must match session-keepalive's Tier-1 threshold
const SUSPICION_RATIO     = 0.67; // escalate when data is > 67% as old as threshold
const SUSPICION_AGE_MIN   = Math.round(TRUST_THRESHOLD_MIN * SUSPICION_RATIO); // 20 min

// Minimum validation tier required for each booking phase.
// Higher tier = stronger (slower) validation.
const PHASE_MIN_TIER = {
  too_early: 1, // plenty of time — Tier-1 file cache is fine
  warmup:    2, // < 10 min to booking open — HTTP ping required
  sniper:    3, // < 1 min to booking open  — Playwright required
  late:      3, // booking window open/passed — Playwright required
};

// ── Booking urgency ───────────────────────────────────────────────────────────

/**
 * Scans all active jobs and returns the most urgent booking phase, or null if
 * there are no active jobs.
 *
 * Priority: sniper/late (highest) → warmup → too_early → null
 *
 * Returned phase drives strict-mode minTier selection.
 */
function getUrgentPhase() {
  try {
    const active = getAllJobs().filter(j => j.is_active === 1);
    let best = null;
    for (const job of active) {
      try {
        const { phase } = getPhase(job);
        if (phase === 'sniper' || phase === 'late') return phase; // peak urgency
        if (phase === 'warmup')    { best = 'warmup';    continue; }
        if (phase === 'too_early' && best === null) best = 'too_early';
      } catch { /* skip malformed job */ }
    }
    return best;
  } catch {
    return null;
  }
}

// ── Suspicion check ───────────────────────────────────────────────────────────

/**
 * Returns a human-readable reason string if either session file's data is
 * approaching the staleness threshold (> SUSPICION_AGE_MIN minutes old), even
 * though it technically still falls within the 30-min trust window.
 *
 * Returns null when data is genuinely fresh (no suspicion).
 *
 * Only called after Tier-1 has already passed — this is a secondary signal
 * that prompts an HTTP double-check (Tier 2) rather than skipping straight to
 * Playwright (Tier 3).
 */
function getSuspicionReason() {
  try {
    const now = Date.now();

    const status = loadStatus();
    if (status?.checkedAt) {
      const ageMin = (now - new Date(status.checkedAt).getTime()) / 60000;
      if (ageMin > SUSPICION_AGE_MIN) {
        return `Daxko data is ${Math.round(ageMin)}m old (suspicion threshold: ${SUSPICION_AGE_MIN}m)`;
      }
    }

    if (fs.existsSync(FW_FILE)) {
      try {
        const fw = JSON.parse(fs.readFileSync(FW_FILE, 'utf8'));
        if (fw?.checkedAt) {
          const fwAgeMin = (now - new Date(fw.checkedAt).getTime()) / 60000;
          if (fwAgeMin > SUSPICION_AGE_MIN) {
            return `FamilyWorks data is ${Math.round(fwAgeMin)}m old (suspicion threshold: ${SUSPICION_AGE_MIN}m)`;
          }
        }
      } catch { /* non-fatal */ }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFwStatus() {
  try {
    if (!fs.existsSync(FW_FILE)) return 'AUTH_UNKNOWN';
    const fw = JSON.parse(fs.readFileSync(FW_FILE, 'utf8'));
    return fw?.status || 'AUTH_UNKNOWN';
  } catch {
    return 'AUTH_UNKNOWN';
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Validate the current session using the cheapest safe method for the context.
 *
 * Options:
 *   forceMinTier {1|2|3}  Override the computed minimum tier.  The effective
 *                          minimum is max(forceMinTier, phaseMinTier).
 *
 * Returns:
 *   {
 *     valid:        boolean,              true = session confirmed active
 *     tier:         1 | 2 | 3,           which tier resolved the result
 *     mode:         'reuse'|'recovery',  'reuse' = no browser/credentials needed (Tier 1/2);
 *                                        'recovery' = browser was launched (Tier 3)
 *     detail:       string,              human-readable summary
 *     daxko:        string,              'DAXKO_READY' | 'AUTH_NEEDS_LOGIN' | 'AUTH_UNKNOWN'
 *     familyworks:  string,              'FAMILYWORKS_READY' | 'AUTH_UNKNOWN' | etc.
 *     checkedAt:    string,              ISO timestamp of this check
 *     strictMode:   boolean,             true if booking window forced a higher minimum tier
 *     minTier:      1 | 2 | 3,          effective minimum tier that was enforced
 *     urgentPhase:  string|null,         most urgent phase across active jobs (or null)
 *   }
 */
async function validateSessionFastThenFallback({ forceMinTier } = {}) {
  const checkedAt    = new Date().toISOString();
  const urgentPhase  = getUrgentPhase();
  const phaseMinTier = urgentPhase ? (PHASE_MIN_TIER[urgentPhase] ?? 1) : 1;
  const strictMode   = phaseMinTier >= 2;
  const minTier      = forceMinTier != null
    ? Math.max(Number(forceMinTier), phaseMinTier)
    : phaseMinTier;

  console.log(
    `[session-validator] Starting — urgentPhase=${urgentPhase ?? 'none'}, ` +
    `minTier=${minTier}, strictMode=${strictMode}`
  );

  // ── Tier 1: File freshness ────────────────────────────────────────────────
  // mode: 'reuse' — no network request, no browser, no credentials
  if (minTier <= 1) {
    const freshness = checkFreshness();
    if (freshness.trusted) {
      const suspicion = getSuspicionReason();
      if (!suspicion) {
        console.log('[session-validator] Tier 1 trusted —', freshness.detail);
        return {
          valid: true, tier: 1, mode: 'reuse',
          detail: `Tier 1: ${freshness.detail}`,
          daxko: 'DAXKO_READY', familyworks: 'FAMILYWORKS_READY',
          checkedAt, strictMode, minTier, urgentPhase,
        };
      }
      // Tier 1 technically passes but data is approaching stale — escalate.
      console.log('[session-validator] Tier 1 suspicious —', suspicion, '— escalating to Tier 2');
    } else {
      console.log('[session-validator] Tier 1 miss —', freshness.detail);
    }
  } else {
    console.log(`[session-validator] Tier 1 skipped (strict mode, minTier=${minTier})`);
  }

  // ── Tier 2: HTTP ping ─────────────────────────────────────────────────────
  // mode: 'reuse' — network request only, no browser, no credentials
  if (minTier <= 2) {
    const pingResult = await pingSessionHttp();
    if (pingResult.trusted) {
      console.log('[session-validator] Tier 2 trusted —', pingResult.detail);
      return {
        valid: true, tier: 2, mode: 'reuse',
        detail: `Tier 2: ${pingResult.detail}`,
        daxko: 'DAXKO_READY', familyworks: 'FAMILYWORKS_READY',
        checkedAt, strictMode, minTier, urgentPhase,
      };
    }
    console.log('[session-validator] Tier 2 miss —', pingResult.detail, '— escalating to Tier 3');
  } else {
    console.log(`[session-validator] Tier 2 skipped (strict mode, minTier=${minTier})`);
  }

  // ── Tier 3: Full Playwright login ─────────────────────────────────────────
  // mode: 'recovery' — browser launched; credentials may have been used.
  // (Tier 3 attempts cookie injection first and only uses credentials if the
  // FW modal shows "Login to Register" — but from the validator's perspective
  // launching the browser at all is a recovery event.)
  console.log('[session-validator] Running Tier 3 (Playwright)...');
  try {
    const checkResult = await runSessionCheck({ source: 'validator' });
    const daxko       = checkResult.valid ? 'DAXKO_READY' : 'AUTH_NEEDS_LOGIN';
    const familyworks = checkResult.valid ? readFwStatus() : 'AUTH_UNKNOWN';
    const valid       = checkResult.valid === true;

    console.log(
      `[session-validator] Tier 3 done — valid=${valid}, daxko=${daxko}, ` +
      `familyworks=${familyworks}`
    );
    return {
      valid, tier: 3, mode: 'recovery',
      detail: `Tier 3: ${checkResult.detail}`,
      daxko, familyworks,
      checkedAt, strictMode, minTier, urgentPhase,
    };
  } catch (err) {
    console.error('[session-validator] Tier 3 error:', err.message);
    return {
      valid: false, tier: 3, mode: 'recovery',
      detail: `Tier 3 error: ${err.message}`,
      daxko: 'AUTH_UNKNOWN', familyworks: 'AUTH_UNKNOWN',
      checkedAt, strictMode, minTier, urgentPhase,
    };
  }
}

module.exports = {
  validateSessionFastThenFallback,
  getUrgentPhase,
  getSuspicionReason,
  PHASE_MIN_TIER,
  SUSPICION_AGE_MIN,
  TRUST_THRESHOLD_MIN,
};
