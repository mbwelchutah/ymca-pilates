// Task #71 — Daxko auth page.goto: 60 s timeout + one-shot TimeoutError retry.
//
// The auth phase used to use Playwright's 30 s default and would bail on
// the first slow-network blip ("Daxko login failed (Timeout 30000 ms
// exceeded — page.goto)").  We bumped the timeout to 60 s and added a
// single TimeoutError retry that's gated on "not past booking open" so
// the click race is never starved of time.
//
// These tests drive the exported `gotoWithRetry` helper with a mocked
// page.goto and confirm:
//   1. A success on the first try makes only one call.
//   2. A TimeoutError on the first try is recovered by a second call.
//   3. Two consecutive timeouts surface the timeout to the caller.
//   4. A non-timeout error never triggers the retry.
//   5. allowRetry: false (the "past booking open" gate) suppresses retry.
//   6. The bumped 60 s timeout is passed to page.goto.

import { describe, test, expect } from 'vitest';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { gotoWithRetry, DAXKO_GOTO_TIMEOUT_MS } = _require('../src/bot/daxko-session');

function makeTimeoutError() {
  const e = new Error('Timeout 60000 ms exceeded — page.goto');
  e.name = 'TimeoutError';
  return e;
}

function makePage(impls) {
  const calls = [];
  const queue = impls.slice();
  return {
    calls,
    goto: async (url, opts) => {
      calls.push({ url, opts });
      const next = queue.shift();
      if (!next) throw new Error('makePage: no more queued goto responses');
      if (next.throw) throw next.throw;
      return next.return ?? null;
    },
  };
}

describe('gotoWithRetry — Daxko auth page.goto retry helper', () => {
  test('passes through on first-attempt success (single call)', async () => {
    const page = makePage([{ return: 'ok' }]);
    const r = await gotoWithRetry(page, 'https://example.com');
    expect(r).toBe('ok');
    expect(page.calls).toHaveLength(1);
  });

  test('retries once on TimeoutError and returns the second response', async () => {
    const page = makePage([{ throw: makeTimeoutError() }, { return: 'recovered' }]);
    const r = await gotoWithRetry(page, 'https://example.com');
    expect(r).toBe('recovered');
    expect(page.calls).toHaveLength(2);
  });

  test('two consecutive timeouts surface the second TimeoutError', async () => {
    const page = makePage([{ throw: makeTimeoutError() }, { throw: makeTimeoutError() }]);
    await expect(gotoWithRetry(page, 'https://example.com')).rejects.toThrow(/timeout/i);
    expect(page.calls).toHaveLength(2);
  });

  test('non-timeout errors are NOT retried', async () => {
    const boom = new Error('net::ERR_CONNECTION_REFUSED');
    const page = makePage([{ throw: boom }]);
    await expect(gotoWithRetry(page, 'https://example.com')).rejects.toThrow(/CONNECTION_REFUSED/);
    expect(page.calls).toHaveLength(1);
  });

  test('allowRetry: false suppresses the retry (past booking open)', async () => {
    const page = makePage([{ throw: makeTimeoutError() }]);
    await expect(
      gotoWithRetry(page, 'https://example.com', { allowRetry: false }),
    ).rejects.toThrow(/timeout/i);
    expect(page.calls).toHaveLength(1);
  });

  test('uses the bumped 60 s timeout (DAXKO_GOTO_TIMEOUT_MS) on every call', async () => {
    const page = makePage([{ throw: makeTimeoutError() }, { return: 'ok' }]);
    await gotoWithRetry(page, 'https://example.com', { waitUntil: 'domcontentloaded' });
    expect(DAXKO_GOTO_TIMEOUT_MS).toBeGreaterThanOrEqual(60000);
    for (const c of page.calls) {
      expect(c.opts.timeout).toBe(DAXKO_GOTO_TIMEOUT_MS);
      expect(c.opts.waitUntil).toBe('domcontentloaded');
    }
  });
});
