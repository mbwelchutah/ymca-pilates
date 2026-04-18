// Pure-function tests for src/health/cadence-policy.js — no mocks needed.
// Covers: <30m hand-off to auto-preflight, AT_RISK halving, DISCONNECTED
// floor, and the Stage-8 consecutive-cheap-failure escalation.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  HEALTH_STATES,
} = require('../src/health/connection-health');
const {
  shouldRunCheapCheck,
  shouldRunDeepCheck,
  getDeepCheckInterval,
  CHEAP_INTERVAL_MS,
  DEEP_INTERVAL_MS,
  MIN_CHEAP_REPROBE_MS,
  MIN_DEEP_REPROBE_MS,
} = require('../src/health/cadence-policy');

const NOW  = 1_700_000_000_000;
const MIN  = 60 * 1000;
const HOUR = 60 * MIN;

describe('getDeepCheckInterval — proximity buckets', () => {
  it('>12h → FAR (6h)', () => {
    expect(getDeepCheckInterval(13 * HOUR)).toBe(DEEP_INTERVAL_MS.FAR);
  });
  it('12h..6h → MID (3h)', () => {
    expect(getDeepCheckInterval(8 * HOUR)).toBe(DEEP_INTERVAL_MS.MID);
  });
  it('6h..2h → NEAR (1h)', () => {
    expect(getDeepCheckInterval(3 * HOUR)).toBe(DEEP_INTERVAL_MS.NEAR);
  });
  it('2h..30m → IMMINENT (30m)', () => {
    expect(getDeepCheckInterval(60 * MIN)).toBe(DEEP_INTERVAL_MS.IMMINENT);
  });
  it('<30m → null (defer to auto-preflight)', () => {
    expect(getDeepCheckInterval(15 * MIN)).toBeNull();
    expect(getDeepCheckInterval(0)).toBeNull();
  });
  it('null msUntilOpen → FAR', () => {
    expect(getDeepCheckInterval(null)).toBe(DEEP_INTERVAL_MS.FAR);
  });
});

describe('shouldRunCheapCheck', () => {
  it('null lastCheapCheckAt → true', () => {
    expect(shouldRunCheapCheck(NOW, { lastCheapCheckAt: null }, null)).toBe(true);
  });

  it('within FAR interval (15m) → false', () => {
    const h = { lastCheapCheckAt: NOW - 5 * MIN };
    expect(shouldRunCheapCheck(NOW, h, null)).toBe(false);
  });

  it('past FAR interval (15m) → true', () => {
    const h = { lastCheapCheckAt: NOW - 16 * MIN };
    expect(shouldRunCheapCheck(NOW, h, null)).toBe(true);
  });

  it('DISCONNECTED uses 60s floor regardless of interval', () => {
    const h = {
      lastCheapCheckAt: NOW - 30 * 1000,           // 30s ago
      currentState:     HEALTH_STATES.DISCONNECTED,
    };
    expect(shouldRunCheapCheck(NOW, h, null)).toBe(false); // <60s
    h.lastCheapCheckAt = NOW - MIN_CHEAP_REPROBE_MS;
    expect(shouldRunCheapCheck(NOW, h, null)).toBe(true);  // ≥60s
  });

  it('NEAR proximity (<2h) uses 5m interval', () => {
    const h = { lastCheapCheckAt: NOW - 6 * MIN };
    expect(shouldRunCheapCheck(NOW, h, 30 * MIN)).toBe(true);
    expect(CHEAP_INTERVAL_MS.NEAR).toBe(5 * MIN);
  });
});

describe('shouldRunDeepCheck — <30m hand-off (Rule 1)', () => {
  it('returns false BEFORE any other rule when msUntilOpen <30m', () => {
    // Even with consecutiveCheapFailures=99 and DISCONNECTED, <30m → false.
    const h = {
      lastDeepCheckAt:           NOW - 10 * HOUR,
      currentState:              HEALTH_STATES.DISCONNECTED,
      consecutiveCheapFailures:  99,
    };
    expect(shouldRunDeepCheck(NOW, h, 15 * MIN)).toBe(false);
    expect(shouldRunDeepCheck(NOW, h, 0)).toBe(false);
  });

  it('returns true when msUntilOpen ≥30m and other conditions met', () => {
    const h = { lastDeepCheckAt: NOW - 7 * HOUR };
    expect(shouldRunDeepCheck(NOW, h, 60 * MIN)).toBe(true);  // IMMINENT, past 30m
  });
});

describe('shouldRunDeepCheck — null lastDeepCheckAt (Rule 2)', () => {
  it('cold start fires immediately', () => {
    expect(shouldRunDeepCheck(NOW, { lastDeepCheckAt: null }, null)).toBe(true);
  });
});

describe('shouldRunDeepCheck — Stage 8 cheap-fails-twice escalation', () => {
  it('counter ≥2 brings deep forward, but only past 5m floor', () => {
    const h = {
      lastDeepCheckAt:          NOW - 4 * MIN,    // <5m
      currentState:             HEALTH_STATES.HEALTHY,
      consecutiveCheapFailures: 2,
    };
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(false);    // floor blocks
    h.lastDeepCheckAt = NOW - MIN_DEEP_REPROBE_MS;
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(true);     // floor satisfied
  });

  it('counter <2 falls through to normal cadence', () => {
    const h = {
      lastDeepCheckAt:          NOW - 4 * MIN,
      currentState:             HEALTH_STATES.HEALTHY,
      consecutiveCheapFailures: 1,
    };
    // Normal HEALTHY+FAR cadence is 6h; 4m << 6h → false.
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(false);
  });

  it('escalation does NOT bypass the <30m hand-off', () => {
    const h = {
      lastDeepCheckAt:          NOW - 30 * MIN,
      currentState:             HEALTH_STATES.HEALTHY,
      consecutiveCheapFailures: 5,
    };
    expect(shouldRunDeepCheck(NOW, h, 10 * MIN)).toBe(false);
  });
});

describe('shouldRunDeepCheck — DISCONNECTED uses 5m floor', () => {
  it('DISCONNECTED + <5m since last → false', () => {
    const h = {
      lastDeepCheckAt: NOW - 4 * MIN,
      currentState:    HEALTH_STATES.DISCONNECTED,
    };
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(false);
  });
  it('DISCONNECTED + ≥5m → true (overrides slower normal cadence)', () => {
    const h = {
      lastDeepCheckAt: NOW - MIN_DEEP_REPROBE_MS,
      currentState:    HEALTH_STATES.DISCONNECTED,
    };
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(true);
  });
});

describe('shouldRunDeepCheck — AT_RISK halves the interval', () => {
  it('uses max(interval/2, 5m) at AT_RISK', () => {
    // FAR interval = 6h, half = 3h, floor = 5m → 3h applies.
    const h = {
      lastDeepCheckAt: NOW - 2 * HOUR,                 // <3h
      currentState:    HEALTH_STATES.AT_RISK,
    };
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(false);
    h.lastDeepCheckAt = NOW - 3 * HOUR;
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(true);
  });

  it('IMMINENT (30m interval) AT_RISK floor is 5m, not 15m', () => {
    // IMMINENT = 30m, half = 15m, but MIN_DEEP_REPROBE_MS = 5m → 15m wins.
    const h = {
      lastDeepCheckAt: NOW - 10 * MIN,
      currentState:    HEALTH_STATES.AT_RISK,
    };
    expect(shouldRunDeepCheck(NOW, h, 60 * MIN)).toBe(false);   // 10m < 15m
    h.lastDeepCheckAt = NOW - 16 * MIN;
    expect(shouldRunDeepCheck(NOW, h, 60 * MIN)).toBe(true);
  });
});

describe('shouldRunDeepCheck — normal cadence (default branch)', () => {
  it('HEALTHY at FAR proximity uses full 6h interval', () => {
    const h = {
      lastDeepCheckAt: NOW - 5 * HOUR,
      currentState:    HEALTH_STATES.HEALTHY,
    };
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(false);
    h.lastDeepCheckAt = NOW - 6 * HOUR;
    expect(shouldRunDeepCheck(NOW, h, null)).toBe(true);
  });
});
