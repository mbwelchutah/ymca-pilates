/**
 * Stage 9.1 — Sniper Confidence Score
 *
 * Derives a 0-100 confidence score for booking readiness from data already
 * present in the sniper run-state and dedicated session check.  No new API
 * calls or server state are required.
 *
 * Score anatomy (baseline):
 *   Session    0-40 pts   (primary gate; dedicated check preferred over bundle)
 *   Discovery  0-35 pts   (class locatability)
 *   Action     0-25 pts   (booking button reachability)
 *
 * Modifiers (applied to the 0-100 baseline):
 *   -5 per unique failure type in last 24 h, capped at -15
 *   -8  when all three dimensions are still "not tested / unknown"
 *   -10 when readiness data is older than 4 h and not fully green
 */

import type { ReadinessBundle } from './readinessTypes'
import type { SniperEvent } from './failureTypes'

interface SessionCheckSnapshot {
  valid:      boolean | null
  checkedAt:  string  | null
}

export interface ConfidenceResult {
  score:       number   // 0-100, integer
  explanation: string   // one compact line, e.g. "Session ready, class found, action reachable"
}

// ── Session score (0-40) ──────────────────────────────────────────────────────

function sessionScore(
  bundle: ReadinessBundle,
  sessionStatus: SessionCheckSnapshot | null,
): number {
  // Dedicated check is authoritative — use it first.
  if (sessionStatus?.valid === true)  return 40
  if (sessionStatus?.valid === false) return 0

  // Fall back to the sniper bundle.
  switch (bundle.session) {
    case 'SESSION_READY':    return 35  // sniper saw it authenticated, but no explicit verify
    case 'SESSION_UNKNOWN':  return 18  // indeterminate — haven't checked
    case 'SESSION_EXPIRED':  return 0
    case 'SESSION_REQUIRED': return 0
    default:                 return 18
  }
}

// ── Discovery score (0-35) ────────────────────────────────────────────────────

function discoveryScore(bundle: ReadinessBundle): number {
  switch (bundle.discovery) {
    case 'DISCOVERY_READY':      return 35
    case 'DISCOVERY_NOT_TESTED': return 14  // unknown but not failed
    case 'DISCOVERY_FAILED':     return 0
    default:                     return 14
  }
}

// ── Action score (0-25) ───────────────────────────────────────────────────────

function actionScore(bundle: ReadinessBundle): number {
  switch (bundle.action) {
    case 'ACTION_READY':      return 25
    case 'ACTION_NOT_TESTED': return 8   // depends on discovery passing
    case 'ACTION_BLOCKED':    return 0
    default:                  return 8
  }
}

// ── Explanation ───────────────────────────────────────────────────────────────

function buildExplanation(
  bundle: ReadinessBundle,
  sessionStatus: SessionCheckSnapshot | null,
  penaltyReasons: string[],
): string {
  const parts: string[] = []

  // Session
  if (sessionStatus?.valid === true) {
    parts.push('session verified')
  } else if (sessionStatus?.valid === false) {
    parts.push('login failed')
  } else {
    switch (bundle.session) {
      case 'SESSION_READY':    parts.push('session ready');   break
      case 'SESSION_UNKNOWN':  parts.push('session unknown'); break
      case 'SESSION_EXPIRED':  parts.push('session expired'); break
      case 'SESSION_REQUIRED': parts.push('login required');  break
    }
  }

  // Discovery
  switch (bundle.discovery) {
    case 'DISCOVERY_READY':      parts.push('class found');       break
    case 'DISCOVERY_NOT_TESTED': parts.push('class not checked'); break
    case 'DISCOVERY_FAILED':     parts.push('class not found');   break
  }

  // Action
  switch (bundle.action) {
    case 'ACTION_READY':      parts.push('action reachable');   break
    case 'ACTION_NOT_TESTED': parts.push('action not checked'); break
    case 'ACTION_BLOCKED':    parts.push('action blocked');     break
  }

  // Append failure penalty summary if any
  if (penaltyReasons.length > 0) {
    parts.push(`${penaltyReasons.length} recent failure${penaltyReasons.length > 1 ? 's' : ''}`)
  }

  // Capitalise the first word only
  const joined = parts.join(', ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

// ── Main export ───────────────────────────────────────────────────────────────

const FAILURE_PENALTY       = 5    // per unique failure type in last 24 h
const MAX_FAILURE_PENALTY   = 15   // cap
const NO_DATA_PENALTY       = 8    // all three dimensions untested / unknown
const STALE_DATA_PENALTY    = 10   // data older than 4 h, not fully green
const STALE_THRESHOLD_MS    = 4 * 60 * 60 * 1000  // 4 hours

export function computeConfidence(
  bundle: ReadinessBundle,
  sessionStatus: SessionCheckSnapshot | null,
  events: SniperEvent[],
  updatedAt: string | null,
): ConfidenceResult {
  // ── Baseline ───────────────────────────────────────────────────────────────
  const base =
    sessionScore(bundle, sessionStatus) +
    discoveryScore(bundle) +
    actionScore(bundle)

  // ── Modifiers ──────────────────────────────────────────────────────────────
  let penalty = 0

  // 1. Recent failure history — unique failure types in last 24 h
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000
  const recentFailureTypes = new Set(
    events
      .filter(e => e.failureType && new Date(e.timestamp).getTime() >= cutoff24h)
      .map(e => e.failureType as string),
  )
  const failurePenalty = Math.min(
    recentFailureTypes.size * FAILURE_PENALTY,
    MAX_FAILURE_PENALTY,
  )
  penalty += failurePenalty

  // 2. No data at all — scheduler hasn't run yet
  const isEntirelyUnknown =
    bundle.session   === 'SESSION_UNKNOWN'      &&
    bundle.discovery === 'DISCOVERY_NOT_TESTED' &&
    bundle.action    === 'ACTION_NOT_TESTED'    &&
    sessionStatus?.valid !== true
  if (isEntirelyUnknown) penalty += NO_DATA_PENALTY

  // 3. Data staleness — readiness result is old but not fully green
  const isFullyGreen =
    (sessionStatus?.valid === true || bundle.session === 'SESSION_READY') &&
    bundle.discovery === 'DISCOVERY_READY' &&
    bundle.action    === 'ACTION_READY'
  if (!isFullyGreen && updatedAt) {
    const age = Date.now() - new Date(updatedAt).getTime()
    if (age > STALE_THRESHOLD_MS) penalty += STALE_DATA_PENALTY
  }

  // ── Final score ────────────────────────────────────────────────────────────
  const score = Math.max(0, Math.min(100, Math.round(base - penalty)))

  // ── Explanation ────────────────────────────────────────────────────────────
  const penaltyReasons = Array.from(recentFailureTypes)
  const explanation = buildExplanation(bundle, sessionStatus, penaltyReasons)

  return { score, explanation }
}
