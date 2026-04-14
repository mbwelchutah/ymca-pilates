// Shared classifier result types.
// Mirrors the shape defined in src/classifier/classTruth.js so both the
// backend classifier and the frontend UI agree on the same contract.

export type ClassState =
  | 'bookable'            // spots available; will register
  | 'waitlist_available'  // full but waitlist is open
  | 'full'                // no spots, no waitlist
  | 'already_registered'  // user is already enrolled
  | 'not_found'           // no matching class on the schedule
  | 'unknown';            // could not determine state

export type MatchType = 'exact' | 'fuzzy' | 'none';

// Stage 2 — freshness buckets and data source for the schedule cache.
export type CacheFreshness  = 'fresh' | 'aging' | 'stale' | 'unknown';
export type ClassTruthSource = 'cache' | 'playwright' | 'live_api' | 'unknown';

export interface ClassTruthResult {
  state:             ClassState;
  matchedClassName:  string | null;
  matchedInstructor: string | null;
  matchedTime:       string | null;
  matchedDate:       string | null;
  confidence:        number;       // 0–100
  isFuzzyMatch:      boolean;
  matchType:         MatchType;
  openSpots:         number | null;
  totalCapacity:     number | null;
  reason:            string | null;
  fetchedAt:         string | null;
  // Stage 2 additions — always present in API responses
  freshness:         CacheFreshness;
  source:            ClassTruthSource;
}

// Convenience type-guard
export function isClassTruthResult(v: unknown): v is ClassTruthResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ClassTruthResult).state === 'string'
  );
}

// Human-readable label for each state (used in Tools / diagnostics)
export const CLASS_STATE_LABEL: Record<ClassState, string> = {
  bookable:           'Bookable',
  waitlist_available: 'Waitlist Available',
  full:               'Full',
  already_registered: 'Already Registered',
  not_found:          'Not Found',
  unknown:            'Unknown',
};
