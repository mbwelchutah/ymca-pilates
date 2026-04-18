// Pure-function tests for src/health/connection-health.js classifier.
// No file I/O, no mocks — exercises the state-derivation rules directly.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  HEALTH_STATES,
  FAILURE_REASONS,
  emptyHealth,
  classifyHealth,
  withDerivedState,
  deepFreshnessThresholdFor,
} = require('../src/health/connection-health');

const NOW = 1_700_000_000_000;
const MIN  = 60 * 1000;
const HOUR = 60 * MIN;

describe('classifyHealth — state derivation', () => {
  it('empty record → DEGRADED', () => {
    expect(classifyHealth(emptyHealth(), null, NOW)).toBe(HEALTH_STATES.DEGRADED);
  });

  it('fresh deep success within window → HEALTHY', () => {
    const h = { ...emptyHealth(),
      lastDeepCheckAt:   NOW - 10 * MIN,
      lastDeepSuccessAt: NOW - 10 * MIN,
    };
    // msUntilOpen=null → FAR window (6h freshness); 10min ago is fresh.
    expect(classifyHealth(h, null, NOW)).toBe(HEALTH_STATES.HEALTHY);
  });

  it('stale deep success outside window → DEGRADED', () => {
    const h = { ...emptyHealth(),
      lastDeepCheckAt:   NOW - 8 * HOUR,
      lastDeepSuccessAt: NOW - 8 * HOUR,
    };
    // FAR window is 6h; 8h ago is stale.
    expect(classifyHealth(h, null, NOW)).toBe(HEALTH_STATES.DEGRADED);
  });

  it('deep failed after a prior success → AT_RISK', () => {
    const h = { ...emptyHealth(),
      lastDeepSuccessAt: NOW - 30 * MIN,
      lastDeepCheckAt:   NOW - 5  * MIN,        // failure more recent
      lastFailureAt:     NOW - 5  * MIN,
      lastFailureReason: FAILURE_REASONS.SCHEDULE_LOAD,
    };
    expect(classifyHealth(h, null, NOW)).toBe(HEALTH_STATES.AT_RISK);
  });

  it('auth-shaped failure after a fresh success → DISCONNECTED', () => {
    const h = { ...emptyHealth(),
      lastDeepSuccessAt: NOW - 10 * MIN,
      lastFailureAt:     NOW - 1  * MIN,
      lastFailureReason: FAILURE_REASONS.AUTH_REDIRECT,
    };
    expect(classifyHealth(h, null, NOW)).toBe(HEALTH_STATES.DISCONNECTED);
  });

  it('auth-shaped failure with no prior deep success → DISCONNECTED', () => {
    const h = { ...emptyHealth(),
      lastFailureAt:     NOW - 1 * MIN,
      lastFailureReason: FAILURE_REASONS.SESSION_EXPIRED,
    };
    expect(classifyHealth(h, null, NOW)).toBe(HEALTH_STATES.DISCONNECTED);
  });

  it('auth-shaped failure OLDER than a recovered success → not DISCONNECTED', () => {
    const h = { ...emptyHealth(),
      lastFailureAt:     NOW - 30 * MIN,
      lastFailureReason: FAILURE_REASONS.AUTH_REDIRECT,
      lastDeepSuccessAt: NOW - 5  * MIN,         // recovered
      lastDeepCheckAt:   NOW - 5  * MIN,
    };
    expect(classifyHealth(h, null, NOW)).toBe(HEALTH_STATES.HEALTHY);
  });

  it('non-auth failure leaves classifier in AT_RISK regardless of reason', () => {
    for (const reason of [
      FAILURE_REASONS.SCHEDULE_LOAD,
      FAILURE_REASONS.ROW_NOT_FOUND,
      FAILURE_REASONS.MODAL_MISMATCH,
      FAILURE_REASONS.NETWORK,
      FAILURE_REASONS.UNKNOWN,
    ]) {
      const h = { ...emptyHealth(),
        lastDeepSuccessAt: NOW - 30 * MIN,
        lastDeepCheckAt:   NOW - 5  * MIN,
        lastFailureAt:     NOW - 5  * MIN,
        lastFailureReason: reason,
      };
      expect(classifyHealth(h, null, NOW)).toBe(HEALTH_STATES.AT_RISK);
    }
  });
});

describe('deepFreshnessThresholdFor — proximity buckets', () => {
  it('null msUntilOpen → FAR (6h)', () => {
    expect(deepFreshnessThresholdFor(null)).toBe(6 * HOUR);
  });
  it('>12h → FAR (6h)', () => {
    expect(deepFreshnessThresholdFor(13 * HOUR)).toBe(6 * HOUR);
  });
  it('12h..6h → MID (3h)', () => {
    expect(deepFreshnessThresholdFor(8 * HOUR)).toBe(3 * HOUR);
  });
  it('6h..2h → NEAR (1h)', () => {
    expect(deepFreshnessThresholdFor(3 * HOUR)).toBe(1 * HOUR);
  });
  it('<2h → IMMINENT (30m)', () => {
    expect(deepFreshnessThresholdFor(45 * MIN)).toBe(30 * MIN);
  });
});

describe('withDerivedState — recomputes currentState in a copy', () => {
  it('does not mutate the input record', () => {
    const h = { ...emptyHealth(), currentState: HEALTH_STATES.HEALTHY };
    const out = withDerivedState(h, null, NOW);
    expect(h.currentState).toBe(HEALTH_STATES.HEALTHY);   // original untouched
    expect(out.currentState).toBe(HEALTH_STATES.DEGRADED); // recomputed
  });
});
