// Type surface for shared/booking-window-shared.mjs — mirrors
// shared/booking-window-shared.d.ts.  Kept in sync by tests.

export const BOOKING_LEAD_DAYS:    number;
export const BOOKING_LEAD_MINUTES: number;
export const BOOKING_LEAD_MS:      number;
export const WARMUP_MS:            number;
export const SNIPER_MS:            number;

export type Phase = 'too_early' | 'warmup' | 'sniper' | 'late' | 'unknown';

export function derivePhase(msUntilOpen: number | null | undefined): Phase;

export function parseClassTime(
  classTime: string | null | undefined
): { hours: number; minutes: number } | null;

export interface BookingWindowJobInput {
  class_time?: string;
  classTime?:  string;
  target_date?: string | null;
  targetDate?:  string | null;
  day_of_week?: string | number | null;
  dayOfWeek?:   string | number | null;
}

export function computeClassStartMs(
  job: BookingWindowJobInput,
  now?: Date
): number | null;

export function computeBookingOpenMs(
  job: BookingWindowJobInput,
  now?: Date
): number | null;

export function pacificOffsetHours(date: Date): number;
