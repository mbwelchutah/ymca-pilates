// Shared class truth classifier.
//
// Accepts a planned class/job description and returns a normalized ClassTruth
// result.  This module is the single source of truth for class availability
// BEFORE Playwright execution runs.  Both Plan and Now screens consume it.
//
// Implementation stages:
//   Stage 1 (this file): module skeleton, state constants, result shape
//   Stage 2: FamilyWorks API data fetch via saved session cookies
//   Stage 3: normalized availability classification from API response
//   Stage 4: fuzzy matching for time/name shifts
//   Stage 5: enriched output shape for UI rendering

// ── Normalized states ─────────────────────────────────────────────────────────
//
// bookable          — spots available; registration is open or will open shortly
// waitlist_available— class is full but a waitlist can be joined
// full              — no open spots and no waitlist (or waitlist also full)
// already_registered— the authenticated user is already enrolled in this class
// not_found         — no acceptable class match found on the schedule
// unknown           — classification could not be determined (API error, no data)

const CLASS_STATES = Object.freeze({
  BOOKABLE:           'bookable',
  WAITLIST_AVAILABLE: 'waitlist_available',
  FULL:               'full',
  ALREADY_REGISTERED: 'already_registered',
  NOT_FOUND:          'not_found',
  UNKNOWN:            'unknown',
});

// ── Result factory ────────────────────────────────────────────────────────────
//
// All fields are always present so consumers never need null-guard optional
// chaining on the result shape.
//
// state            {string}       — one of CLASS_STATES
// matchedClassName {string|null}  — class title from the schedule as matched
// matchedInstructor{string|null}  — instructor name from the schedule
// matchedTime      {string|null}  — time string from the schedule (e.g. "7:30 AM")
// matchedDate      {string|null}  — ISO date string of the matched occurrence
// confidence       {number}       — 0–100 match confidence score
// isFuzzyMatch     {boolean}      — true if match required fuzzy tolerance
// matchType        {string}       — 'exact' | 'fuzzy' | 'none'
// openSpots        {number|null}  — available spots (null = not provided by API)
// totalCapacity    {number|null}  — class capacity  (null = not provided by API)
// reason           {string|null}  — human-readable explanation for the state
// fetchedAt        {string|null}  — ISO timestamp when the API data was fetched
function makeResult(state, partial = {}) {
  return {
    state,
    matchedClassName:   partial.matchedClassName   ?? null,
    matchedInstructor:  partial.matchedInstructor  ?? null,
    matchedTime:        partial.matchedTime        ?? null,
    matchedDate:        partial.matchedDate        ?? null,
    confidence:         partial.confidence         ?? 0,
    isFuzzyMatch:       partial.isFuzzyMatch       ?? false,
    matchType:          partial.matchType          ?? 'none',
    openSpots:          partial.openSpots          ?? null,
    totalCapacity:      partial.totalCapacity      ?? null,
    reason:             partial.reason             ?? null,
    fetchedAt:          partial.fetchedAt          ?? null,
  };
}

// ── Classifier entry point ────────────────────────────────────────────────────
//
// job: {
//   classTitle  {string}        e.g. "Core Pilates"
//   dayOfWeek   {string}        e.g. "Friday"
//   classTime   {string}        e.g. "7:30 AM"
//   instructor  {string|null}   e.g. "Stephanie"
//   targetDate  {string|null}   ISO date e.g. "2026-04-17"
// }
//
// Returns Promise<ClassTruthResult>
//
// Stage 1: returns UNKNOWN (stub) — API fetch + classification added in Stages 2–3.
async function classifyClass(job) {
  return makeResult(CLASS_STATES.UNKNOWN, {
    reason: 'Classifier pending API integration (Stage 2)',
  });
}

module.exports = { CLASS_STATES, makeResult, classifyClass };
