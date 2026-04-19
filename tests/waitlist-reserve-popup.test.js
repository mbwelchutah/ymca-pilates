/**
 * Coverage for clickWaitlistReserveConfirmation() in src/bot/register-pilates.js.
 *
 * That helper handles FamilyWorks's two-step waitlist flow added in Task #99:
 * after clicking "Waitlist", a small confirmation popup appears showing the
 * user's name with a white "Reserve" button + gray "Close" button. Clicking
 * Reserve is what actually enrolls the user on the waitlist; without it,
 * FamilyWorks records nothing.
 *
 * Task #101 extended the helper to *also* poll, after the Reserve click, for
 * the post-Reserve confirmed state — either an orange "#N On Waitlist" badge
 * or a Cancel button replacing Reserve in the same popup. The return shape
 * always includes `confirmedState` ∈ {waitlisted, cancel_only, unknown} and
 * `waitlistPosition` (number|null).
 *
 * Scenarios exercised against a fake Playwright page object whose
 * page.evaluate() runs the helper's DOM callbacks against a JSDOM document
 * (so the actual Reserve+Close detection logic is exercised, not mocked):
 *
 *   1. Popup with both "Reserve" and "Close" visible siblings → helper
 *      returns clicked: true. Three post-Reserve sub-scenarios:
 *        a) Badge + position number ("#10 On Waitlist") appears →
 *           confirmedState: 'waitlisted', waitlistPosition: 10.
 *        b) Cancel button replaces Reserve, no badge →
 *           confirmedState: 'cancel_only', waitlistPosition: null.
 *        c) Neither badge nor Cancel-only appears within the window →
 *           confirmedState: 'unknown', waitlistPosition: null.
 *   2. No popup ever appears within the maxMs window → helper returns
 *      popupSeen:false, clicked:false, confirmedState:'unknown'.
 *   3. Popup appears but the Reserve click fails → helper returns
 *      popupSeen:true, clicked:false, error, confirmedState:'unknown'.
 *
 * Plus a unit test for the inline POSITION_RE used by the helper.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM }                from 'jsdom';
import { createRequire }        from 'module';

const _require = createRequire(import.meta.url);
const { clickWaitlistReserveConfirmation } = _require('../src/bot/register-pilates');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// JSDOM's getBoundingClientRect returns all-zero rects, which the helper's
// isVisible() treats as hidden. Patch the prototype so visible nodes report a
// non-zero box.
function patchJsdomVisibility(window) {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0 };
  };
}

// Build a fake Playwright page whose page.evaluate() runs the helper's
// callback against the supplied JSDOM document, and whose page.locator()
// returns a stub whose .first().click() invokes the supplied clickImpl.
//
// clickImpl receives (selector, opts, dom) and may mutate the DOM to
// simulate FW's post-Reserve transition (e.g. add an "#N On Waitlist" badge
// or swap the Reserve button for Cancel).
function makeFakePage({ dom, clickImpl } = {}) {
  const taggedSelectors = [];
  return {
    async evaluate(fn, arg) {
      if (!dom) return { found: false };
      // The helper's callback references `document` and `getComputedStyle` as
      // free identifiers (they are globals inside the real browser frame).
      // Stash and replace the Node globals so the lookups resolve to JSDOM.
      const origDoc = global.document;
      const origGCS = global.getComputedStyle;
      global.document = dom.window.document;
      global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
      try {
        return fn(arg);
      } finally {
        global.document = origDoc;
        global.getComputedStyle = origGCS;
      }
    },
    locator(selector) {
      taggedSelectors.push(selector);
      return {
        first() {
          return {
            async click(opts) {
              if (clickImpl) return clickImpl(selector, opts, dom);
            },
          };
        },
      };
    },
    // Real wait so Date.now() advances and the deadline loop terminates.
    async waitForTimeout(ms) {
      await new Promise(r => setTimeout(r, ms));
    },
    // Used by captureFailureScreenshot internals — return null so it no-ops.
    async screenshot() { return null; },
    url() { return 'about:blank'; },
    _taggedSelectors: taggedSelectors,
  };
}

function makePopupDom() {
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html><body>
      <div role="dialog" class="confirm-popup">
        <p>Michael Welch</p>
        <button>Reserve</button>
        <button>Close</button>
      </div>
    </body></html>
  `);
  patchJsdomVisibility(dom.window);
  return dom;
}

function makeEmptyDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div>nothing here</div></body></html>`);
  patchJsdomVisibility(dom.window);
  return dom;
}

// ---------------------------------------------------------------------------
// 1) Popup visible → Reserve gets clicked
// ---------------------------------------------------------------------------
describe('clickWaitlistReserveConfirmation — popup with Reserve + Close', () => {
  it('detects the popup, tags the Reserve button, and clicks it', async () => {
    const dom = makePopupDom();

    let clickedSelector = null;
    let clickedTagged   = false;
    const page = makeFakePage({
      dom,
      clickImpl: (selector, _opts, d) => {
        clickedSelector = selector;
        // The helper passes a [data-ymca-reserve-<ts>] selector.
        const m = selector.match(/^\[(data-ymca-reserve-\d+)\]$/);
        expect(m).not.toBeNull();
        const attr   = m[1];
        const target = d.window.document.querySelector(`[${attr}]`);
        // The tagged element must be the Reserve button (not Close, not body).
        expect(target).not.toBeNull();
        expect(target.textContent.trim()).toBe('Reserve');
        clickedTagged = true;
      },
    });

    // confirmMaxMs:50 keeps the post-Reserve poll short — this test only
    // cares that the click happened; confirmed-state is 'unknown' (no DOM
    // mutation), which is fine.
    const result = await clickWaitlistReserveConfirmation(page, 1500, { confirmMaxMs: 50 });

    expect(result.popupSeen).toBe(true);
    expect(result.clicked).toBe(true);
    expect(result.confirmedState).toBe('unknown');
    expect(result.waitlistPosition).toBeNull();
    expect(clickedTagged).toBe(true);
    expect(clickedSelector).toMatch(/^\[data-ymca-reserve-\d+\]$/);
  });

  // ── Task #101: post-Reserve confirmed-state sub-scenarios ────────────────
  it('post-Reserve: detects "#N On Waitlist" badge and returns the position', async () => {
    const dom = makePopupDom();
    const page = makeFakePage({
      dom,
      clickImpl: (_selector, _opts, d) => {
        // Simulate FW updating the popup with the orange position badge.
        const dialog = d.window.document.querySelector('[role="dialog"]');
        const badge = d.window.document.createElement('span');
        badge.textContent = '#10 On Waitlist';
        dialog.appendChild(badge);
      },
    });

    const result = await clickWaitlistReserveConfirmation(page, 1500, { confirmMaxMs: 1000, jobId: 42 });

    expect(result.popupSeen).toBe(true);
    expect(result.clicked).toBe(true);
    expect(result.confirmedState).toBe('waitlisted');
    expect(result.waitlistPosition).toBe(10);
  });

  it('post-Reserve: detects Cancel-only (Reserve removed) → cancel_only', async () => {
    const dom = makePopupDom();
    const page = makeFakePage({
      dom,
      clickImpl: (_selector, _opts, d) => {
        // Swap the Reserve button for a Cancel button — no badge text.
        const dialog = d.window.document.querySelector('[role="dialog"]');
        const buttons = [...dialog.querySelectorAll('button')];
        const reserve = buttons.find(b => b.textContent.trim() === 'Reserve');
        reserve.textContent = 'Cancel';
      },
    });

    const result = await clickWaitlistReserveConfirmation(page, 1500, { confirmMaxMs: 1000 });

    expect(result.popupSeen).toBe(true);
    expect(result.clicked).toBe(true);
    expect(result.confirmedState).toBe('cancel_only');
    expect(result.waitlistPosition).toBeNull();
  });

  it('post-Reserve: neither badge nor Cancel-only appears → unknown', async () => {
    const dom = makePopupDom();
    const page = makeFakePage({
      dom,
      // No DOM mutation — popup remains in its pre-Reserve state with
      // both Reserve and Close still present, no badge text. Helper should
      // poll until confirmMaxMs and return 'unknown'.
      clickImpl: () => { /* no-op */ },
    });

    const result = await clickWaitlistReserveConfirmation(page, 1500, { confirmMaxMs: 100 });

    expect(result.popupSeen).toBe(true);
    expect(result.clicked).toBe(true);
    expect(result.confirmedState).toBe('unknown');
    expect(result.waitlistPosition).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2) No popup within the window → silent no-op
// ---------------------------------------------------------------------------
describe('clickWaitlistReserveConfirmation — no popup within window', () => {
  it('returns popupSeen:false / clicked:false / unknown without throwing', async () => {
    const dom  = makeEmptyDom();
    const page = makeFakePage({
      dom,
      clickImpl: () => { throw new Error('locator.click should not be called when no popup'); },
    });

    // Use a short window so the test finishes quickly.  POLL_MS in the helper
    // is 200, so this loops once or twice and then exits.
    const result = await clickWaitlistReserveConfirmation(page, 50);

    expect(result.popupSeen).toBe(false);
    expect(result.clicked).toBe(false);
    expect(result.confirmedState).toBe('unknown');
    expect(result.waitlistPosition).toBeNull();
    expect(page._taggedSelectors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3) Popup visible but the Reserve click fails
// ---------------------------------------------------------------------------
describe('clickWaitlistReserveConfirmation — popup seen but click fails', () => {
  it('returns popupSeen:true / clicked:false / error / unknown', async () => {
    const dom  = makePopupDom();
    const page = makeFakePage({
      dom,
      clickImpl: () => { throw new Error('click intercepted by test'); },
    });

    const result = await clickWaitlistReserveConfirmation(page, 1500);

    expect(result.popupSeen).toBe(true);
    expect(result.clicked).toBe(false);
    expect(result.error).toBe('click intercepted by test');
    expect(result.confirmedState).toBe('unknown');
    expect(result.waitlistPosition).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4) Position-extraction regex
// ---------------------------------------------------------------------------
describe('Task #101 waitlist position regex', () => {
  // Mirror of the inline POSITION_RE used in clickWaitlistReserveConfirmation.
  // Kept in sync manually — if the helper's regex changes, update this too.
  const POSITION_RE = /#?\s*(\d+)\s*on\s*(?:the\s*)?wait[\s-]?list/i;

  it.each([
    ['#10 On Waitlist',     10],
    ['# 7 on waitlist',     7],
    ['3 on waitlist',       3],
    ['12 on the waitlist',  12],
    ['#1 On Wait-list',     1],
    ['#25 ON WAITLIST',     25],
  ])('matches %j → position %i', (text, expected) => {
    const m = text.match(POSITION_RE);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBe(expected);
  });

  it.each([
    'You are registered',
    'On waitlist',                 // no number
    'Reserve',
    'something something list',
  ])('rejects non-position text %j', (text) => {
    expect(text.match(POSITION_RE)).toBeNull();
  });
});
