/**
 * Coverage for clickWaitlistReserveConfirmation() in src/bot/register-pilates.js.
 *
 * That helper handles FamilyWorks's two-step waitlist flow added in Task #99:
 * after clicking "Waitlist", a small confirmation popup appears showing the
 * user's name with a white "Reserve" button + gray "Close" button. Clicking
 * Reserve is what actually enrolls the user on the waitlist; without it,
 * FamilyWorks records nothing.
 *
 * Three scenarios are exercised against a fake Playwright page object whose
 * page.evaluate() runs the helper's DOM-detection callback against a JSDOM
 * document (so the actual Reserve+Close detection logic is exercised, not
 * just mocked out):
 *
 *   1. Popup with both "Reserve" and "Close" visible siblings → helper returns
 *      { popupSeen: true, clicked: true } and triggers the Reserve click on
 *      the tagged element.
 *   2. No popup ever appears within the maxMs window → helper returns
 *      { popupSeen: false, clicked: false } without throwing.
 *   3. Popup appears but the Reserve click fails → helper returns
 *      { popupSeen: true, clicked: false, error: <message> }.
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

    const result = await clickWaitlistReserveConfirmation(page, 1500);

    expect(result).toEqual({ popupSeen: true, clicked: true });
    expect(clickedTagged).toBe(true);
    expect(clickedSelector).toMatch(/^\[data-ymca-reserve-\d+\]$/);
  });
});

// ---------------------------------------------------------------------------
// 2) No popup within the window → silent no-op
// ---------------------------------------------------------------------------
describe('clickWaitlistReserveConfirmation — no popup within window', () => {
  it('returns { popupSeen:false, clicked:false } without throwing', async () => {
    const dom  = makeEmptyDom();
    const page = makeFakePage({
      dom,
      clickImpl: () => { throw new Error('locator.click should not be called when no popup'); },
    });

    // Use a short window so the test finishes quickly.  POLL_MS in the helper
    // is 200, so this loops once or twice and then exits.
    const result = await clickWaitlistReserveConfirmation(page, 50);

    expect(result).toEqual({ popupSeen: false, clicked: false });
    expect(page._taggedSelectors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3) Popup visible but the Reserve click fails
// ---------------------------------------------------------------------------
describe('clickWaitlistReserveConfirmation — popup seen but click fails', () => {
  it('returns { popupSeen:true, clicked:false, error }', async () => {
    const dom  = makePopupDom();
    const page = makeFakePage({
      dom,
      clickImpl: () => { throw new Error('click intercepted by test'); },
    });

    const result = await clickWaitlistReserveConfirmation(page, 1500);

    expect(result.popupSeen).toBe(true);
    expect(result.clicked).toBe(false);
    expect(result.error).toBe('click intercepted by test');
  });
});
