// Coverage for the App.tsx sticky-on-transient-miss decision helper (Task #68).
// Pure-function tests — no React, no jsdom, deterministic clock.

import { describe, it, expect } from 'vitest'
import { decideStickySelection } from './stickySelection'

const GRACE = 12_000
const T0    = 1_000_000_000_000   // arbitrary epoch ms

const job = (id: number, is_active = 1) => ({ id, is_active })

describe('decideStickySelection — Task #68 sticky-on-transient-miss', () => {
  it('returns ok when the selected job is present in the jobs list', () => {
    const r = decideStickySelection({
      jobs: [job(10), job(24)],
      selectedJobId: 10,
      lastKnownJob: job(10),
      missingSinceMs: null,
      nowMs: T0,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({ action: 'ok' })
  })

  it('returns resync (with new missingSinceMs) on first miss when last-known matches', () => {
    const r = decideStickySelection({
      jobs: [job(24)],
      selectedJobId: 10,
      lastKnownJob: job(10),
      missingSinceMs: null,
      nowMs: T0,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({
      action: 'resync',
      missingSinceMs: T0,
      expiresAtMs:    T0 + GRACE,
    })
  })

  it('keeps resync within the grace window even when the jobs list is empty', () => {
    // Single-job disappearance: list becomes empty but the user's selection
    // had a snapshot — banner must engage instead of dropping the card.
    const r = decideStickySelection({
      jobs: [],
      selectedJobId: 10,
      lastKnownJob: job(10),
      missingSinceMs: T0,
      nowMs: T0 + 5_000,
      graceWindowMs: GRACE,
    })
    expect(r.action).toBe('resync')
  })

  it('falls back to null after grace expires when no jobs are available', () => {
    const r = decideStickySelection({
      jobs: [],
      selectedJobId: 10,
      lastKnownJob: job(10),
      missingSinceMs: T0,
      nowMs: T0 + GRACE + 1,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({ action: 'fallback', nextSelectedId: null })
  })

  it('falls back to first active job after grace expires when alternatives exist', () => {
    const r = decideStickySelection({
      jobs: [job(7, 0), job(24, 1), job(31, 1)],
      selectedJobId: 10,
      lastKnownJob: job(10),
      missingSinceMs: T0,
      nowMs: T0 + GRACE + 1,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({ action: 'fallback', nextSelectedId: 24 })
  })

  it('falls back immediately (no resync) when there is no last-known snapshot', () => {
    const r = decideStickySelection({
      jobs: [job(24)],
      selectedJobId: 10,
      lastKnownJob: null,
      missingSinceMs: null,
      nowMs: T0,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({ action: 'fallback', nextSelectedId: 24 })
  })

  it('falls back immediately when the last-known snapshot is for a different job', () => {
    // Defensive: if the snapshot ref is stale, we must NOT keep a foreign card.
    const r = decideStickySelection({
      jobs: [job(24)],
      selectedJobId: 10,
      lastKnownJob: job(99),
      missingSinceMs: null,
      nowMs: T0,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({ action: 'fallback', nextSelectedId: 24 })
  })

  it('clears miss tracking and returns ok when the missing job returns within grace', () => {
    // Simulates the cycle the user reported: card disappears for one poll,
    // then reappears.  The next decision must be ok (not still resync) so
    // the banner clears and the live job replaces the snapshot.
    const r = decideStickySelection({
      jobs: [job(10), job(24)],
      selectedJobId: 10,
      lastKnownJob: job(10),
      missingSinceMs: T0,
      nowMs: T0 + 4_000,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({ action: 'ok' })
  })

  it('falls back the moment grace expires (deletion-to-empty flushes stale card)', () => {
    // Even though jobs is empty, the boundary case at exactly graceWindowMs
    // must be treated as expired so the resync banner does not stick forever.
    const r = decideStickySelection({
      jobs: [],
      selectedJobId: 10,
      lastKnownJob: job(10),
      missingSinceMs: T0,
      nowMs: T0 + GRACE,
      graceWindowMs: GRACE,
    })
    expect(r).toEqual({ action: 'fallback', nextSelectedId: null })
  })
})
