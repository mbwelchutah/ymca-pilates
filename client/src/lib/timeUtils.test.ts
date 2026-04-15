import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { epochMsToDate, durationMsToDate, formatTime } from './timeUtils'

// Pinned epoch: April 15, 2026 at 08:00:00 UTC (= booking-window open time for a
// Saturday April 18 class at 9:00 AM PT, 3 days + 60 min before class start).
const KNOWN_EPOCH_MS = new Date('2026-04-15T08:00:00.000Z').getTime()

describe('epochMsToDate', () => {
  it('returns the correct Date for a known epoch — NOT year ~112,000', () => {
    const result = epochMsToDate(KNOWN_EPOCH_MS)
    expect(result).not.toBeNull()
    expect(result!.getFullYear()).toBe(2026)
    expect(result!.getUTCHours()).toBe(8)
    expect(result!.getTime()).toBe(KNOWN_EPOCH_MS)
  })

  it('returns null for null input', () => {
    expect(epochMsToDate(null)).toBeNull()
    expect(epochMsToDate(undefined)).toBeNull()
  })
})

describe('durationMsToDate', () => {
  const FAKE_NOW = new Date('2026-04-14T21:24:00.000Z').getTime() // 9:24 PM UTC

  beforeEach(() => { vi.setSystemTime(FAKE_NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('adds the duration to Date.now() — producing the correct future Date', () => {
    const ONE_HOUR_MS = 60 * 60 * 1000
    const result = durationMsToDate(ONE_HOUR_MS)
    expect(result).not.toBeNull()
    expect(result!.getTime()).toBe(FAKE_NOW + ONE_HOUR_MS) // 10:24 PM UTC
    expect(result!.getFullYear()).toBe(2026)
  })

  it('returns null for null input', () => {
    expect(durationMsToDate(null)).toBeNull()
  })
})

describe('epoch vs duration — critical guard', () => {
  it('epochMsToDate does NOT add Date.now() — year stays 2026, not ~2082', () => {
    // The bug: new Date(Date.now() + KNOWN_EPOCH_MS) — both operands are ~1.77 trillion ms,
    // so their sum (~3.54 trillion ms) represents roughly year 2082. epochMsToDate must
    // use new Date(epochMs) directly, with no Date.now() addition.
    const correct = epochMsToDate(KNOWN_EPOCH_MS)!
    const buggy   = new Date(Date.now() + KNOWN_EPOCH_MS)

    expect(correct.getFullYear()).toBe(2026)            // correct: exact epoch preserved
    expect(buggy.getFullYear()).toBeGreaterThan(2050)   // buggy: wrong year (≥2082 from 2026)
    expect(correct.getTime()).toBe(KNOWN_EPOCH_MS)      // correct: getTime() round-trips
    expect(buggy.getTime()).not.toBe(KNOWN_EPOCH_MS)    // buggy: wildly different
  })
})
