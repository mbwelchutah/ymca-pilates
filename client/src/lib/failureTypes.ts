// ── Execution phase ────────────────────────────────────────────────────────────
// Where in the sniper pipeline something occurred.
// Distinct from the booking-window Phase (too_early | warmup | sniper | late).

export type ExecutionPhase =
  | 'AUTH'          // Login / session establishment
  | 'NAVIGATION'    // Navigating to the schedule page
  | 'DISCOVERY'     // Searching and filtering for the class
  | 'VERIFY'        // Confirming the found class matches title/time/instructor
  | 'MODAL'         // Opening the class detail / booking modal
  | 'ACTION'        // Clicking Reserve / Waitlist
  | 'CONFIRMATION'  // Detecting post-click success confirmation
  | 'RECOVERY'      // Any automated recovery attempt after a failure
  | 'SYSTEM'        // Scheduler-level meta events (e.g. warmup skip)

// ── Failure types ─────────────────────────────────────────────────────────────
// Granular failure identifiers — primarily used in Tools diagnostics and logs.
// Mapped to readiness impacts via failureMapper.ts.

export type FailureType =
  // Auth / session
  | 'AUTH_LOGIN_FAILED'        // Login form submit did not authenticate
  | 'AUTH_SESSION_EXPIRED'     // Was logged in; page now shows login prompt
  | 'AUTH_RESTORE_FAILED'      // Cookie/session restore attempt failed
  | 'AUTH_SURFACE_MISMATCH'    // Unexpected page/URL after auth attempt

  // Navigation
  | 'NAVIGATION_TIMEOUT'       // Page did not load within deadline
  | 'NAVIGATION_FAILED'        // Hard navigation error (network / 404 / crash)

  // Discovery
  | 'DISCOVERY_EMPTY'          // No classes visible after filters applied
  | 'DISCOVERY_FILTER_FAILED'  // Filter could not be applied (UI mismatch)
  | 'DISCOVERY_AMBIGUOUS'      // Multiple equally-scored candidates, can't pick

  // Verify
  | 'VERIFY_MISMATCH'              // General mismatch across multiple fields
  | 'VERIFY_AMBIGUOUS'             // Two candidates with identical score
  | 'VERIFY_TIME_MISMATCH'         // Matched title/instructor but wrong time
  | 'VERIFY_INSTRUCTOR_MISMATCH'   // Matched title/time but wrong instructor
  | 'VERIFY_TITLE_MISMATCH'        // Class name does not match expected

  // Modal
  | 'MODAL_NOT_OPENED'         // Click on class row did not open modal
  | 'MODAL_TIMEOUT'            // Modal took too long to appear
  | 'MODAL_LOGIN_REQUIRED'     // Modal shows "Login to Register" instead of action
  | 'MODAL_ACTION_NOT_FOUND'   // Modal is open but no Reserve/Waitlist button
  | 'MODAL_ACTION_AMBIGUOUS'   // Multiple eligible action buttons in modal

  // Action
  | 'ACTION_NOT_FOUND'          // Reserve/Waitlist button gone or not visible
  | 'ACTION_TIMEOUT'            // Button click did not resolve within deadline
  | 'ACTION_FORCE_CLICK_USED'   // Standard click failed; fallback click used (soft warning)
  | 'ACTION_FORCE_CLICK_FAILED' // Fallback click also failed

  // Post-click / confirmation
  | 'CONFIRMATION_FAILED'           // No success signal after click
  | 'POST_CLICK_RESULT_AMBIGUOUS'   // Response is present but unclear
  | 'WAITLIST_ONLY'                 // Only waitlist was available; no reserve
  | 'CAPACITY_FULL'                 // Class is full with no waitlist option

  // System
  | 'SYSTEM_EXCEPTION'  // Unhandled JS/Playwright exception

// ── Sniper event ──────────────────────────────────────────────────────────────
// Shared structured result emitted by the sniper, preflight, and runtime paths.
// Stored for Tools diagnostics; condensed form drives Now screen readiness.

export interface SniperEvent {
  phase:        ExecutionPhase
  failureType?: FailureType
  message:      string
  timestamp:    string              // ISO 8601
  screenshot?:  string             // Relative path to screenshot file
  evidence?:    Record<string, unknown>  // Arbitrary structured context
}
