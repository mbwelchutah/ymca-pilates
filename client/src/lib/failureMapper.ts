import type { FailureType } from './failureTypes'
import type { SessionReadiness, DiscoveryReadiness, ActionReadiness, ModalReadiness } from './readinessTypes'

// ── Readiness impact ──────────────────────────────────────────────────────────
// A partial readiness bundle describing which dimensions a failure affects.
// Undefined dimensions are unaffected by the failure.

export interface ReadinessImpact {
  session?:   SessionReadiness
  discovery?: DiscoveryReadiness
  action?:    ActionReadiness
  modal?:     ModalReadiness
}

// ── Failure → readiness impact map ───────────────────────────────────────────
// Given a FailureType, returns which readiness dimensions it degrades and how.
// Used by the sniper engine and preflight to update the readiness bundle
// from concrete failure evidence.

export function failureToReadinessImpact(failureType: FailureType): ReadinessImpact {
  switch (failureType) {

    // Auth failures → session degraded
    case 'AUTH_LOGIN_FAILED':
    case 'AUTH_RESTORE_FAILED':
      return { session: 'SESSION_REQUIRED' }

    case 'AUTH_SESSION_EXPIRED':
      return { session: 'SESSION_EXPIRED', action: 'ACTION_BLOCKED' }

    case 'AUTH_SURFACE_MISMATCH':
      return { session: 'SESSION_UNKNOWN' }

    // Navigation failures → cascade to discovery + action
    case 'NAVIGATION_TIMEOUT':
    case 'NAVIGATION_FAILED':
      return { discovery: 'DISCOVERY_FAILED', action: 'ACTION_BLOCKED' }

    // Discovery failures → class not locatable
    case 'DISCOVERY_EMPTY':
    case 'DISCOVERY_FILTER_FAILED':
    case 'DISCOVERY_AMBIGUOUS':
      return { discovery: 'DISCOVERY_FAILED' }

    // Verify failures → class found but not confirmed
    case 'VERIFY_MISMATCH':
    case 'VERIFY_AMBIGUOUS':
    case 'VERIFY_TIME_MISMATCH':
    case 'VERIFY_INSTRUCTOR_MISMATCH':
    case 'VERIFY_TITLE_MISMATCH':
      return { discovery: 'DISCOVERY_FAILED' }

    // Modal failures → modal layer + action layer
    case 'MODAL_NOT_OPENED':
    case 'MODAL_TIMEOUT':
      return { modal: 'MODAL_BLOCKED', action: 'ACTION_BLOCKED' }

    case 'MODAL_LOGIN_REQUIRED':
      return { modal: 'MODAL_LOGIN_REQUIRED', session: 'SESSION_EXPIRED', action: 'ACTION_BLOCKED' }

    case 'MODAL_ACTION_NOT_FOUND':
    case 'MODAL_ACTION_AMBIGUOUS':
      return { modal: 'MODAL_READY', action: 'ACTION_BLOCKED' }

    // Action failures → action layer blocked
    case 'ACTION_NOT_FOUND':
    case 'ACTION_TIMEOUT':
    case 'ACTION_FORCE_CLICK_FAILED':
      return { action: 'ACTION_BLOCKED' }

    case 'ACTION_FORCE_CLICK_USED':
      // Soft warning — fallback succeeded; no hard block
      return {}

    // Post-click / confirmation failures
    case 'CONFIRMATION_FAILED':
    case 'POST_CLICK_RESULT_AMBIGUOUS':
    case 'WAITLIST_ONLY':
    case 'CAPACITY_FULL':
      return { action: 'ACTION_BLOCKED' }

    // System exception → all dimensions uncertain
    case 'SYSTEM_EXCEPTION':
      return {
        session:   'SESSION_UNKNOWN',
        discovery: 'DISCOVERY_FAILED',
        action:    'ACTION_BLOCKED',
      }

    default:
      return {}
  }
}

// ── Failure → human label ─────────────────────────────────────────────────────
// Short diagnostic label shown in Tools failure lists.

export const FAILURE_LABEL: Record<FailureType, string> = {
  AUTH_LOGIN_FAILED:           'Login failed',
  AUTH_SESSION_EXPIRED:        'Session expired',
  AUTH_RESTORE_FAILED:         'Session restore failed',
  AUTH_SURFACE_MISMATCH:       'Unexpected page after auth',

  NAVIGATION_TIMEOUT:          'Navigation timeout',
  NAVIGATION_FAILED:           'Navigation error',

  DISCOVERY_EMPTY:             'No classes found',
  DISCOVERY_FILTER_FAILED:     'Filter could not be applied',
  DISCOVERY_AMBIGUOUS:         'Ambiguous class match',

  VERIFY_MISMATCH:             'Class mismatch',
  VERIFY_AMBIGUOUS:            'Ambiguous verification',
  VERIFY_TIME_MISMATCH:        'Time mismatch',
  VERIFY_INSTRUCTOR_MISMATCH:  'Instructor mismatch',
  VERIFY_TITLE_MISMATCH:       'Title mismatch',

  MODAL_NOT_OPENED:            'Modal did not open',
  MODAL_TIMEOUT:               'Modal timeout',
  MODAL_LOGIN_REQUIRED:        'Modal requires login',
  MODAL_ACTION_NOT_FOUND:      'No action in modal',
  MODAL_ACTION_AMBIGUOUS:      'Ambiguous action in modal',

  ACTION_NOT_FOUND:            'Action button not found',
  ACTION_TIMEOUT:              'Action timed out',
  ACTION_FORCE_CLICK_USED:     'Force-click fallback used',
  ACTION_FORCE_CLICK_FAILED:   'Force-click fallback failed',

  CONFIRMATION_FAILED:         'Confirmation failed',
  POST_CLICK_RESULT_AMBIGUOUS: 'Post-click result unclear',
  WAITLIST_ONLY:               'Waitlist only',
  CAPACITY_FULL:               'Class full',

  SYSTEM_EXCEPTION:            'System exception',
}
