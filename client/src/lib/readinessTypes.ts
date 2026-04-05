// ── Session readiness ──────────────────────────────────────────────────────────
// Whether the sniper has (or can establish) an authenticated session.

export type SessionReadiness =
  | 'SESSION_READY'      // Authenticated on the schedule surface
  | 'SESSION_REQUIRED'   // No session — user must log in
  | 'SESSION_UNKNOWN'    // State indeterminate (not yet checked)
  | 'SESSION_EXPIRED'    // Was authenticated; now shows login prompt

// ── Discovery readiness ───────────────────────────────────────────────────────
// Whether the sniper can locate the target class in the schedule.

export type DiscoveryReadiness =
  | 'DISCOVERY_READY'       // Class found and verified in a prior check
  | 'DISCOVERY_NOT_TESTED'  // No check has been performed yet
  | 'DISCOVERY_FAILED'      // Check ran but class could not be located/verified

// ── Action readiness ──────────────────────────────────────────────────────────
// Whether the booking action (Reserve / Waitlist) is visible and reachable.

export type ActionReadiness =
  | 'ACTION_READY'       // Button detected and reachable in a prior check
  | 'ACTION_NOT_TESTED'  // No check has been performed yet
  | 'ACTION_BLOCKED'     // Button missing, requires login, or ambiguous

// ── Modal readiness ───────────────────────────────────────────────────────────
// Whether the target class modal can be opened and its content read.

export type ModalReadiness =
  | 'MODAL_READY'           // Modal opened and content verified (time + instructor)
  | 'MODAL_NOT_TESTED'      // No modal check has been performed yet
  | 'MODAL_BLOCKED'         // Modal could not be opened after card click
  | 'MODAL_LOGIN_REQUIRED'  // Modal shows "Login to Register" — session issue

// ── Preflight result ──────────────────────────────────────────────────────────
// The outcome of a preflight (dry-run discovery) check.

export type PreflightResult =
  | 'PREFLIGHT_PASS'             // All checks passed — sniper is primed
  | 'PREFLIGHT_FAIL_AUTH'        // Failed at session/auth step
  | 'PREFLIGHT_FAIL_DISCOVERY'   // Failed to find / match the class
  | 'PREFLIGHT_FAIL_VERIFY'      // Found a class but verification failed
  | 'PREFLIGHT_FAIL_MODAL'       // Modal did not open or was unexpected
  | 'PREFLIGHT_FAIL_ACTION'      // Booking action was missing or blocked

// ── Sniper operational state ──────────────────────────────────────────────────
// High-level state machine for the sniper; derived from the readiness bundle
// and live runtime signals.

export type SniperState =
  | 'SNIPER_WAITING'            // Holding — booking window not yet open
  | 'SNIPER_READY'              // All checks green; armed for window open
  | 'SNIPER_ARMED'              // Window is imminent; sniper locked and ready
  | 'SNIPER_BOOKING'            // Actively clicking the booking action
  | 'SNIPER_CONFIRMING'         // Waiting for post-click confirmation
  | 'SNIPER_BLOCKED_AUTH'       // Cannot proceed — session missing/expired
  | 'SNIPER_BLOCKED_DISCOVERY'  // Cannot proceed — class not found
  | 'SNIPER_BLOCKED_ACTION'     // Cannot proceed — action unavailable
  | 'SNIPER_RECOVERY_ACTIVE'    // Running recovery after a partial failure

// ── Readiness bundle ──────────────────────────────────────────────────────────
// Composite snapshot of all three readiness dimensions.
// This is the primary input to resolveSniperState().

export interface ReadinessBundle {
  session:    SessionReadiness
  discovery:  DiscoveryReadiness
  action:     ActionReadiness
  modal?:     ModalReadiness
  preflight?: PreflightResult
}
