import type {
  ReadinessBundle,
  SniperState,
  SessionReadiness,
  DiscoveryReadiness,
  ActionReadiness,
  ModalReadiness,
  PreflightResult,
} from './readinessTypes'

// ── Default / initial bundle ──────────────────────────────────────────────────
// Used before any preflight or runtime data is available.

export const DEFAULT_READINESS: ReadinessBundle = {
  session:   'SESSION_UNKNOWN',
  discovery: 'DISCOVERY_NOT_TESTED',
  action:    'ACTION_NOT_TESTED',
  modal:     'MODAL_NOT_TESTED',
}

// ── Sniper state resolver ─────────────────────────────────────────────────────
// Derives the SniperState from the readiness bundle + optional runtime signals.
// Blocked states take priority over ready states; runtime signals override all.

export interface RuntimeSignals {
  armed?:      boolean  // Booking window imminent (e.g. in warmup/sniper phase)
  booking?:    boolean  // Actively executing a booking attempt
  confirming?: boolean  // Waiting for post-click confirmation
  recovering?: boolean  // Running recovery after partial failure
}

export function resolveSniperState(
  bundle: ReadinessBundle,
  runtime: RuntimeSignals = {},
): SniperState {
  // Explicit runtime phase signals take highest priority
  if (runtime.recovering)  return 'SNIPER_RECOVERY_ACTIVE'
  if (runtime.confirming)  return 'SNIPER_CONFIRMING'
  if (runtime.booking)     return 'SNIPER_BOOKING'
  if (runtime.armed)       return 'SNIPER_ARMED'

  // Auth blocks — cannot proceed without a session
  if (
    bundle.session === 'SESSION_REQUIRED' ||
    bundle.session === 'SESSION_EXPIRED'
  ) return 'SNIPER_BLOCKED_AUTH'

  // Discovery blocks — session ok but class not locatable
  if (bundle.discovery === 'DISCOVERY_FAILED') return 'SNIPER_BLOCKED_DISCOVERY'

  // Action blocks — class found but action unreachable
  if (bundle.action === 'ACTION_BLOCKED') return 'SNIPER_BLOCKED_ACTION'

  // All three dimensions confirmed ready → SNIPER_READY
  if (
    bundle.session   === 'SESSION_READY'    &&
    bundle.discovery === 'DISCOVERY_READY'  &&
    bundle.action    === 'ACTION_READY'
  ) return 'SNIPER_READY'

  // Anything else → still gathering evidence
  return 'SNIPER_WAITING'
}

// ── Preflight → readiness updater ─────────────────────────────────────────────
// Given a preflight result, returns the updated readiness bundle dimensions.
// Merges with the caller's existing bundle.

export function applyPreflightResult(
  existing: ReadinessBundle,
  result: PreflightResult,
): ReadinessBundle {
  switch (result) {
    case 'PREFLIGHT_PASS':
      return {
        session:   'SESSION_READY',
        discovery: 'DISCOVERY_READY',
        action:    'ACTION_READY',
        preflight: result,
      }
    case 'PREFLIGHT_FAIL_AUTH':
      return { ...existing, session: 'SESSION_REQUIRED', preflight: result }
    case 'PREFLIGHT_FAIL_DISCOVERY':
      return { ...existing, discovery: 'DISCOVERY_FAILED', preflight: result }
    case 'PREFLIGHT_FAIL_VERIFY':
      return { ...existing, discovery: 'DISCOVERY_FAILED', preflight: result }
    case 'PREFLIGHT_FAIL_MODAL':
      return { ...existing, action: 'ACTION_BLOCKED', preflight: result }
    case 'PREFLIGHT_FAIL_ACTION':
      return { ...existing, action: 'ACTION_BLOCKED', preflight: result }
    default:
      return { ...existing, preflight: result }
  }
}

// ── Human-readable labels ─────────────────────────────────────────────────────

export const SNIPER_STATE_LABEL: Record<SniperState, string> = {
  SNIPER_WAITING:            'Waiting',
  SNIPER_READY:              'Ready',
  SNIPER_ARMED:              'Auto-registration ready',
  SNIPER_BOOKING:            'Registering…',
  SNIPER_CONFIRMING:         'Confirming…',
  SNIPER_BLOCKED_AUTH:       'Login required',
  SNIPER_BLOCKED_DISCOVERY:  'Class not found',
  SNIPER_BLOCKED_ACTION:     'Not open yet',
  SNIPER_RECOVERY_ACTIVE:    'Recovering',
}

export const SESSION_LABEL: Record<SessionReadiness, string> = {
  SESSION_READY:    'Ready',
  SESSION_REQUIRED: 'Login required',
  SESSION_UNKNOWN:  'Unknown',
  SESSION_EXPIRED:  'Expired',
}

export const DISCOVERY_LABEL: Record<DiscoveryReadiness, string> = {
  DISCOVERY_READY:      'Found',
  DISCOVERY_NOT_TESTED: 'Not tested',
  DISCOVERY_FAILED:     'Not found',
}

export const ACTION_LABEL: Record<ActionReadiness, string> = {
  ACTION_READY:      'Reachable',
  ACTION_NOT_TESTED: 'Not tested',
  ACTION_BLOCKED:    'Not open yet',
}

export const MODAL_LABEL: Record<ModalReadiness, string> = {
  MODAL_READY:           'Reachable',
  MODAL_NOT_TESTED:      'Not tested',
  MODAL_BLOCKED:         'Not reachable',
  MODAL_LOGIN_REQUIRED:  'Login required',
}

export const PREFLIGHT_LABEL: Record<PreflightResult, string> = {
  PREFLIGHT_PASS:             'Passed',
  PREFLIGHT_FAIL_AUTH:        'Failed — login required',
  PREFLIGHT_FAIL_DISCOVERY:   'Failed — class not found',
  PREFLIGHT_FAIL_VERIFY:      'Failed — verification mismatch',
  PREFLIGHT_FAIL_MODAL:       'Failed — modal issue',
  PREFLIGHT_FAIL_ACTION:      'Failed — action blocked',
}

// ── Composite readiness ────────────────────────────────────────────────────────
// Combines all four dimensions (session, discovery, modal, action) into one
// user-facing result — the single source of truth for the Now screen badge
// and the Readiness section composite label.

export type CompositeStatus =
  | 'COMPOSITE_READY'
  | 'COMPOSITE_WAITLIST'
  | 'COMPOSITE_CLASS_FULL'
  | 'COMPOSITE_CLASS_CLOSED'
  | 'COMPOSITE_LOGIN_REQUIRED'
  | 'COMPOSITE_CLASS_NOT_FOUND'
  | 'COMPOSITE_MODAL_ISSUE'
  | 'COMPOSITE_ACTION_BLOCKED'
  | 'COMPOSITE_NOT_TESTED'

export interface CompositeReadiness {
  status:  CompositeStatus
  label:   string
  color:   'green' | 'amber' | 'red' | 'gray'
  detail:  string
}

export function computeCompositeReadiness(
  bundle: ReadinessBundle,
  preflightStatus: string | null,   // raw status from the last logRunSummary
  sniperState: SniperState | null,
): CompositeReadiness {
  // Priority: auth > discovery > modal blocked > waitlist > action blocked > ready > untested

  // 1. Auth / session blocked (modal login required is an auth sub-case)
  if (
    bundle.session === 'SESSION_REQUIRED' ||
    bundle.session === 'SESSION_EXPIRED'  ||
    bundle.modal   === 'MODAL_LOGIN_REQUIRED'
  ) {
    const detail = bundle.modal === 'MODAL_LOGIN_REQUIRED'
      ? 'Login required in the registration modal'
      : 'Session expired or missing — log in via Settings'
    return { status: 'COMPOSITE_LOGIN_REQUIRED', label: 'Login required', color: 'red', detail }
  }

  // 2. Class not discovered
  if (bundle.discovery === 'DISCOVERY_FAILED') {
    return {
      status: 'COMPOSITE_CLASS_NOT_FOUND',
      label:  'Class not found',
      color:  'red',
      detail: 'Class card not located on the schedule page',
    }
  }

  // 3. Modal could not be opened
  if (bundle.modal === 'MODAL_BLOCKED') {
    return {
      status: 'COMPOSITE_MODAL_ISSUE',
      label:  'Modal issue',
      color:  'red',
      detail: 'Registration modal could not be opened',
    }
  }

  // 4. Waitlist — status-driven because bundle uses same ACTION_BLOCKED code for
  //    waitlist, cancel-only, and unknown actions
  if (preflightStatus === 'waitlist_only') {
    return {
      status: 'COMPOSITE_WAITLIST',
      label:  'Waitlist only',
      color:  'amber',
      detail: 'Class is full — waitlist is available',
    }
  }

  // 5a. Class is explicitly full (no spots, "Closed - Full" / "0 spots left" detected)
  //     Separate from waitlist_only — these classes have NO waitlist button visible.
  if (preflightStatus === 'full') {
    return {
      status: 'COMPOSITE_CLASS_FULL',
      label:  'Class full',
      color:  'amber',
      detail: 'Class is full — no spots available',
    }
  }

  // 5b. Registration explicitly closed (not a timing issue — YMCA closed it)
  if (preflightStatus === 'closed') {
    return {
      status: 'COMPOSITE_CLASS_CLOSED',
      label:  'Registration closed',
      color:  'red',
      detail: 'Registration is closed for this class',
    }
  }

  // 5c. Action not available yet (cancel-only, unknown, or no register button)
  if (bundle.action === 'ACTION_BLOCKED' || preflightStatus === 'action_blocked') {
    return {
      status: 'COMPOSITE_ACTION_BLOCKED',
      label:  'Not open yet',
      color:  'amber',
      detail: 'Everything is working — just waiting for the window to open',
    }
  }

  // 6. All dimensions confirmed ready
  if (sniperState === 'SNIPER_READY') {
    return {
      status: 'COMPOSITE_READY',
      label:  'Ready to book',
      color:  'green',
      detail: 'Session active, class found, action reachable',
    }
  }

  // 7. Not enough data yet
  return {
    status: 'COMPOSITE_NOT_TESTED',
    label:  'Not tested',
    color:  'gray',
    detail: 'Run Check to verify readiness',
  }
}
