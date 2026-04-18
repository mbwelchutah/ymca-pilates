// Task #77 — guard test for the shared booking-window math.
//
// Both Node (src/scheduler/booking-window.js) and the React client
// (client/src/screens/NowScreen.tsx) now import their constants and
// derivePhase from shared/booking-window-shared.js.  This test:
//
//   1. Pins the constant values so a sneaky change is caught in CI.
//   2. Asserts derivePhase honours the boundary semantics (open boundary
//      via `>`, not `>=`, matching the legacy Node code).
//   3. Asserts the Node booking-window.js still produces a bookingOpen
//      that is exactly classStart - BOOKING_LEAD_MS, so the shared
//      math and the Node wrapper agree on the window.
//   4. Asserts the shared computeBookingOpenMs and the Node
//      getBookingWindow().bookingOpen.getTime() return the same number
//      for several realistic jobs (week-recurring + target_date).
//
// If a future commit drifts NowScreen back to a private copy of the
// math, the contract will silently break — but tests/freshness-fields
// and the Tools UI tests will fail loudly because both expect the
// shared value.  Belt-and-braces.

import { describe, it, expect } from 'vitest';

const shared       = require('../shared/booking-window-shared');
const bookingWindow = require('../src/scheduler/booking-window');

describe('shared/booking-window-shared.js — constants are pinned', () => {
  it('exports the documented business-rule constants', () => {
    expect(shared.BOOKING_LEAD_DAYS).toBe(3);
    expect(shared.BOOKING_LEAD_MINUTES).toBe(60);
    expect(shared.BOOKING_LEAD_MS).toBe(
      (3 * 24 * 60 * 60 * 1000) + (60 * 60 * 1000),
    );
    expect(shared.WARMUP_MS).toBe(10 * 60 * 1000);
    expect(shared.SNIPER_MS).toBe(1 * 60 * 1000);
  });

  it('Node booking-window.js re-exports the same constants', () => {
    expect(bookingWindow.BOOKING_LEAD_DAYS).toBe(shared.BOOKING_LEAD_DAYS);
    expect(bookingWindow.BOOKING_LEAD_MINUTES).toBe(shared.BOOKING_LEAD_MINUTES);
    expect(bookingWindow.WARMUP_MS).toBe(shared.WARMUP_MS);
    expect(bookingWindow.SNIPER_MS).toBe(shared.SNIPER_MS);
    expect(bookingWindow.derivePhase).toBe(shared.derivePhase);
  });
});

describe('shared/booking-window-shared.js — derivePhase semantics', () => {
  const { derivePhase, WARMUP_MS, SNIPER_MS } = shared;

  it('returns "unknown" when input is null/NaN', () => {
    expect(derivePhase(null)).toBe('unknown');
    expect(derivePhase(undefined)).toBe('unknown');
    expect(derivePhase(NaN)).toBe('unknown');
  });

  it('classifies the four future/past phases with strict-`>` boundaries', () => {
    expect(derivePhase(WARMUP_MS + 1)).toBe('too_early');
    expect(derivePhase(WARMUP_MS    )).toBe('warmup');     // boundary collapses left
    expect(derivePhase(WARMUP_MS - 1)).toBe('warmup');
    expect(derivePhase(SNIPER_MS + 1)).toBe('warmup');
    expect(derivePhase(SNIPER_MS    )).toBe('sniper');
    expect(derivePhase(SNIPER_MS - 1)).toBe('sniper');
    expect(derivePhase(1            )).toBe('sniper');
    expect(derivePhase(0            )).toBe('late');
    expect(derivePhase(-1_000       )).toBe('late');
  });
});

describe('shared/booking-window-shared.js — Node wrapper agrees on bookingOpen', () => {
  const cases = [
    { class_time: '7:45 AM', day_of_week: 'Wednesday' },
    { class_time: '6:00 PM', day_of_week: 'Saturday'  },
    { class_time: '9:00 AM', target_date: '2099-04-21' },
    { class_time: '12:00 PM', target_date: '2099-12-31' },
  ];

  for (const job of cases) {
    it(`bookingOpen matches classStart - BOOKING_LEAD_MS for ${JSON.stringify(job)}`, () => {
      const classStart = shared.computeClassStartMs(job);
      const wrapped    = bookingWindow.getBookingWindow(job);
      expect(classStart).not.toBeNull();
      expect(wrapped.nextClass.getTime()).toBe(classStart);
      // Node uses Date.setDate / setMinutes which respects DST; the shared
      // math uses fixed BOOKING_LEAD_MS.  Across DST these can differ by
      // ±1h.  Test windows above are intentionally not on DST transitions.
      expect(wrapped.bookingOpen.getTime()).toBe(classStart - shared.BOOKING_LEAD_MS);
    });
  }

  it('shared.computeBookingOpenMs == Node getBookingWindow.bookingOpen', () => {
    for (const job of cases) {
      const a = shared.computeBookingOpenMs(job);
      const b = bookingWindow.getBookingWindow(job).bookingOpen.getTime();
      expect(a).toBe(b);
    }
  });
});

describe('shared/booking-window-shared.js — parseClassTime', () => {
  it('handles AM, PM, midnight and noon edge cases', () => {
    expect(shared.parseClassTime('7:45 AM')).toEqual({ hours: 7,  minutes: 45 });
    expect(shared.parseClassTime('12:00 AM')).toEqual({ hours: 0,  minutes: 0  });
    expect(shared.parseClassTime('12:30 PM')).toEqual({ hours: 12, minutes: 30 });
    expect(shared.parseClassTime('1:05 PM')).toEqual({ hours: 13, minutes: 5  });
    expect(shared.parseClassTime('garbage')).toBeNull();
    expect(shared.parseClassTime(null)).toBeNull();
  });
});
