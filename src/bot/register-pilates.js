// Bot entry point — run by GitHub Actions every Sunday at 2:45 PM UTC.
// Logs into Daxko, finds the Wednesday Core Pilates class with Stephanie
// Sanders, and registers (or joins the waitlist). Set DRY_RUN=1 to run
// with a visible browser without clicking Register/Waitlist.
const fs   = require('fs');
const path = require('path');
const { captureFailureScreenshot, screenshotRelPath } = require('./screenshot-capture');
const waitlistPositionStore = require('./waitlist-position-store');
const { createSession }  = require('./daxko-session');
const { getBookingWindow } = require('../scheduler/booking-window');
const { checkJobConsistency } = require('../scheduler/job-consistency');
const { recordFailure }  = require('../db/failures');
const {
  createRunState, advance, recordTiming, recordTimingMetrics, emitEvent, emitSuccess, saveState,
} = require('./sniper-readiness');
const { deriveTimingMetrics, detectTimingDegradation } = require('../scheduler/timing-metrics');
const { getLearnedRunSpeed } = require('../scheduler/timing-learner');
const { saveStatus: saveSessionStatus } = require('./session-check');
const { acquireLock, releaseLock, isLocked } = require('./auth-lock');
const { updateAuthState } = require('./auth-state');
const { saveCookies, pingSessionHttp } = require('./session-ping');
const replayStore = require('./replay-store');
const { mergeAndSaveEntries } = require('../classifier/scheduleCache');
const { writeJsonAtomic } = require('../util/atomic-json');

// ── Session-file helpers ──────────────────────────────────────────────────────
// Write to familyworks-session.json from the booking/preflight pipeline so that
// FamilyWorks readiness is always up-to-date after every run.
const _DATA_DIR = path.resolve(__dirname, '../data');
const _FW_FILE  = path.join(_DATA_DIR, 'familyworks-session.json');
function _saveFwStatus(status) {
  try {
    writeJsonAtomic(_FW_FILE, status);
  } catch (e) {
    console.warn('[register-pilates] saveFwStatus failed:', e.message);
  }
}

// Maps modal-verification reasonTag → structured failure reason code.
const REASONTAG_TO_REASON = {
  'time':            'modal_time_mismatch',
  'instructor':      'modal_instructor_mismatch',
  'time-instructor': 'modal_mismatch',
  'title':           'modal_title_mismatch',     // Stage 5: same-time wrong-class (e.g. Flow Yoga vs Rise & Align Yoga at 9:00)
  'time-title':      'modal_mismatch',           // both time and title wrong
  'error':           'unexpected_error',
};

// Stage 8: helper — distinguishes wrong-time mismatch (target slot likely absent)
// from wrong-title mismatch (we picked the wrong row; target may still exist).
// Used to split the post-mismatch failure classification so wrong-class cases
// are no longer collapsed into 'class_not_found' (which means "class is not on
// the schedule") when in fact we just couldn't reliably target it.
function _isTitleOnlyMismatch(reasonTag) {
  return reasonTag === 'title';
}
function _isTimeMismatchTag(reasonTag) {
  return reasonTag === 'time' || reasonTag === 'time-instructor' || reasonTag === 'time-title';
}

// Convert an absolute screenshot path to the compact reference stored in DB.
// New-style paths (under data/screenshots/{date}/) → "date/filename.png"
// Old-style paths (flat screenshots/ dir) → "filename.png"
function _screenshotRef(filePath) {
  if (!filePath) return null;
  const rel = screenshotRelPath(filePath);
  return rel || path.basename(filePath);
}

// ── Action-button selector strategies ────────────────────────────────────────
// Each entry is [playwrightSelector, humanLabel]. Strategies are tried in order;
// the first one that returns count > 0 wins. Having [role="button"] as a fallback
// handles Bubble.io builds that render interactive elements as ARIA divs rather
// than native <button> tags.
const ACTION_SELECTORS = {
  register: [
    ['button:has-text("Register"), button:has-text("Reserve")',                   'button (Register/Reserve)'],
    ['[role="button"]:has-text("Register"), [role="button"]:has-text("Reserve")', 'role=button (Register/Reserve)'],
  ],
  waitlist: [
    ['button:has-text("aitlist")',            'button (Waitlist)'],
    ['[role="button"]:has-text("aitlist")',   'role=button (Waitlist)'],
  ],
  // "Cancel" button appearing means a booking/waitlist-join was successfully completed.
  cancel: [
    ['button:has-text("Cancel")',            'button (Cancel)'],
    ['[role="button"]:has-text("Cancel")',   'role=button (Cancel)'],
  ],
  // Combined selector used for the signal-driven modal wait.
  modalReady: [
    'button:has-text("Register")', 'button:has-text("Reserve")',
    '[role="button"]:has-text("Register")', '[role="button"]:has-text("Reserve")',
    'button:has-text("aitlist")', '[role="button"]:has-text("aitlist")',
    'button:has-text("Login")',   '[role="button"]:has-text("Login")',
  ].join(', '),
  allVisible:    'button:visible, [role="button"]:visible',
  loginRequired: /login to register|sign in to register/i,
};

// Returns a [role="dialog"] Locator if one is present in the page, null otherwise.
// Used by detectActionButtons() call sites where the modal is known to be open,
// so button queries can be scoped to the dialog rather than the full page.
async function _getModalScope(page) {
  try {
    const dialogLoc = page.locator('[role="dialog"]');
    return (await dialogLoc.count()) > 0 ? dialogLoc.first() : null;
  } catch { return null; }
}

// Detects which action buttons are present in the current page state.
// Tries each selector strategy in order; stops at first match.
//
// @param {import('playwright').Page}    page  Playwright Page object
// @param {import('playwright').Locator|null} root  Optional modal-scoped locator.
//   When provided (e.g. page.locator('[role="dialog"]').first()), all button
//   queries are scoped to that subtree, avoiding full-page scans.
//   Pass null (default) to retain the original page-wide behavior.
//
// Returns:
//   { hasRegister, hasWaitlist, hasCancel, hasLoginRequired,
//     registerBtn, waitlistBtn, cancelBtn, allBtnTexts,
//     registerStrategy, waitlistStrategy }
async function detectActionButtons(page, root = null) {
  const scope = root || page;
  const allBtnTexts = await scope.locator(ACTION_SELECTORS.allVisible).allTextContents().catch(() => []);

  let registerBtn = null;
  let registerStrategy = 'not found';
  for (const [sel, label] of ACTION_SELECTORS.register) {
    const loc = scope.locator(sel);
    if ((await loc.count()) > 0) {
      registerBtn      = loc;
      registerStrategy = label;
      break;
    }
  }

  let waitlistBtn = null;
  let waitlistStrategy = 'not found';
  for (const [sel, label] of ACTION_SELECTORS.waitlist) {
    const loc = scope.locator(sel);
    if ((await loc.count()) > 0) {
      waitlistBtn      = loc;
      waitlistStrategy = label;
      break;
    }
  }

  // "Cancel" button appearing after a click means the booking completed successfully.
  let cancelBtn = null;
  for (const [sel] of ACTION_SELECTORS.cancel) {
    const loc = scope.locator(sel);
    if ((await loc.count()) > 0) {
      cancelBtn = loc;
      break;
    }
  }

  const hasLoginRequired = allBtnTexts.some(t => ACTION_SELECTORS.loginRequired.test(t));
  const hasRegister = registerBtn !== null;
  const hasWaitlist = waitlistBtn !== null;
  const hasCancel   = cancelBtn   !== null;

  const scopeLabel = root ? 'modal-scoped' : 'page-wide';
  console.log(`[action-detect] (${scopeLabel}) register: ${registerStrategy} | waitlist: ${waitlistStrategy} | cancel: ${hasCancel ? 'found' : 'not found'}`);

  return { hasRegister, hasWaitlist, hasCancel, hasLoginRequired, registerBtn, waitlistBtn, cancelBtn, allBtnTexts, registerStrategy, waitlistStrategy };
}

// ── Action-state classifier ───────────────────────────────────────────────────
// Classifies the *actual* booking opportunity available in the open modal.
// This is intentionally separate from modal reachability: a reachable modal
// can still belong to a class that is full, closed, or already registered.
//
// Returns one of:
//   'bookable'           — Register / Reserve button available; spot(s) exist
//   'waitlist_available' — Waitlist button available, no Register
//   'full'               — Class is full; strong full/closed signals present
//   'already_registered' — Cancel/Unregister button visible, no booking action
//   'closed'             — Closed without explicit full signal (e.g. registration ended)
//   'unknown'            — Could not determine state from available signals
//
// Strong full/closed signals in button text OR page body always override
// soft structural signals (modal reachable, class card found).
//
// @param {string[]} allBtnTexts  All visible button texts (from detectActionButtons)
// @param {string}   pageText     Raw page body text for broader signal detection
function classifyActionState(allBtnTexts, pageText = '') {
  const btnLower  = allBtnTexts.map(t => (t || '').toLowerCase().trim());
  const pageLower = (pageText || '').toLowerCase();

  // ── Button-text signals ─────────────────────────────────────────────────────
  const hasRegisterBtn = btnLower.some(t => /\bregister\b|\breserve\b/.test(t));
  const hasWaitlistBtn = btnLower.some(t => /\bwaitlist\b|\bwait\s*list\b/.test(t));
  const hasCancelBtn   = btnLower.some(t => /\bcancel\b|\bunregister\b/.test(t));
  // "Closed - Full", "Closed", "Full" in a button slot = strong full/closed signal
  const hasFullBtn     = btnLower.some(t => /\bfull\b/.test(t));
  const hasClosedBtn   = btnLower.some(t => /\bclosed\b/.test(t));
  // Countdown button shown before the registration window opens, e.g.
  //   "11 hrs until open registration", "45 mins until open registration",
  //   "2 days until open registration", "Opens in 3 hrs", "Registration opens soon"
  const hasCountdownBtn = btnLower.some(t =>
    /\b(\d+\s*(hr|hrs|hour|hours|min|mins|minute|minutes|day|days|sec|secs|second|seconds))\s+until\s+open\s+registration\b/.test(t)
    || /\bopens?\s+in\s+\d+/.test(t)
    || /\bregistration\s+opens?\b/.test(t)
    || /\buntil\s+open\s+registration\b/.test(t)
  );

  // ── Page-body signals ───────────────────────────────────────────────────────
  // "0 spot left", "0 spots left", "no spots available"
  const hasZeroSpots      = /\b0\s+spots?\s*(left|available|remaining)|\bno\s+spots?\s*(left|available)/i.test(pageLower);
  // "Registration Unavailable" / "Booking Unavailable"
  const hasRegUnavailable = /registration\s+unavailable|booking\s+unavailable/i.test(pageLower);
  // "N/N attendees" where both numbers match and N > 0 — full roster (e.g. "30/30 Attendees")
  const _attendeeMatch    = pageLower.match(/\b(\d+)\/(\d+)\s*attendees?\b/);
  const hasFullAttendeeCount = _attendeeMatch !== null
    && _attendeeMatch[1] === _attendeeMatch[2]
    && parseInt(_attendeeMatch[1], 10) > 0;

  // ── Derived flags ───────────────────────────────────────────────────────────
  // isFull: any strong signal that no booking spot exists
  const isFull   = hasFullBtn || hasZeroSpots || hasRegUnavailable || hasFullAttendeeCount;
  // isClosed: explicit closed state without a specific "full" signal
  const isClosed = hasClosedBtn && !isFull;

  // ── Classification (priority order) ────────────────────────────────────────
  // Strong full/closed signals win even if softer booking signals are also present
  if (isFull)                              return 'full';
  if (isClosed)                            return 'closed';
  if (hasRegisterBtn)                      return 'bookable';          // Register beats Waitlist
  if (hasWaitlistBtn)                      return 'waitlist_available';
  if (hasCancelBtn && !hasRegisterBtn)     return 'already_registered';
  // Countdown ("X hrs until open registration") = known pre-window state, not unknown
  if (hasCountdownBtn)                     return 'not_open_yet';
  return 'unknown';
}

// ── Signal-driven post-click settle ───────────────────────────────────────────
// Replaces flat waitForTimeout() calls inside checkBookingConfirmed.
// Exits as soon as the DOM transitions away from the "bookable" posture:
//   • Cancel button appears  → booking processed (success or waitlist)
//   • Register+Waitlist both disappear → modal state changed
// If neither fires within maxMs the cap expires and the caller proceeds to
// its normal readSignals() check unchanged.
async function _waitForConfirmSignal(page, maxMs) {
  try {
    await page.waitForFunction(() => {
      const btns  = [...document.querySelectorAll('button, [role="button"]')];
      const texts = btns.map(b => (b.textContent || '').toLowerCase());
      if (texts.some(t => /\bcancel\b/.test(t))) return true;           // Cancel appeared
      const hasAction = texts.some(t => /\bregister\b|\breserve\b|\baitlist\b/.test(t));
      return !hasAction;                                                  // action buttons gone
    }, null, { timeout: maxMs });
  } catch { /* timeout cap reached — fall through to readSignals() */ }
}

// ── Task #99: Waitlist two-step Reserve confirmation popup ────────────────────
// FamilyWorks's waitlist flow has TWO steps that the regular open-spot Register
// flow does not have:
//   1. Click the orange "Waitlist" button on the main class modal.
//   2. A SECOND small confirmation popup appears on top of the main modal,
//      showing the user's name (e.g. "Michael Welch") with a white "Reserve"
//      button + gray "Close" button. Clicking Reserve is what actually enrolls
//      the user on the waitlist; without it, FW records nothing.
//
// This helper runs AFTER the Waitlist click and BEFORE confirmBookingOutcome().
// It is a no-op when the popup never appears (FW behavior may vary), so the
// existing Stage 10E classifier still produces the verdict either way.
//
// Disambiguation from the main class modal: the confirmation popup has BOTH a
// "Reserve" button AND a "Close" button as visible siblings — the main modal
// uses an "X" icon to dismiss, not a "Close" button, so the (Reserve + Close)
// pair is a strong, specific marker that this is the second-step popup and
// not the original class modal.
//
// @param {import('playwright').Page} page
// @param {number} [maxMs=1500] Max time to wait for the popup to appear.
// @param {object} [opts]
// @param {number} [opts.confirmMaxMs=5000] After Reserve is clicked, how long
//        to keep polling the popup for the post-Reserve confirmed state (the
//        orange "#N On Waitlist" badge or a Cancel button replacing Reserve).
// @param {number|string|null} [opts.jobId] Used only for forensic screenshot
//        naming when the badge is observed.
// @returns {Promise<{
//   popupSeen: boolean,
//   clicked: boolean,
//   error?: string,
//   confirmedState: 'waitlisted'|'cancel_only'|'unknown',
//   waitlistPosition: number|null,
// }>}
//
// Task #101 — after the Reserve click, FW updates the same popup with an
// orange "#N On Waitlist" badge alongside Cancel + Close. We poll for that
// badge (or, as a fallback, a bare Cancel button replacing Reserve) so the
// bot can report the position number — FW's only durable confirmation that
// the waitlist join actually committed (My Schedule still shows "No Events"
// for waitlist entries).
async function clickWaitlistReserveConfirmation(page, maxMs = 1500, opts = {}) {
  const POLL_MS = 200;
  const deadline = Date.now() + maxMs;
  const CONFIRM_MAX_MS  = Number.isFinite(opts.confirmMaxMs) ? opts.confirmMaxMs : 5000;
  const CONFIRM_POLL_MS = 250;
  const jobId = opts.jobId ?? null;
  // Match "#10 On Waitlist", "# 10 on waitlist", "10 on waitlist", "10 on the
  // waitlist". Captures the digit run for the position number.
  const POSITION_RE = /#?\s*(\d+)\s*on\s*(?:the\s*)?wait[\s-]?list/i;
  try {
    while (Date.now() < deadline) {
      // Detect a visible "Reserve" button that has a visible "Close" sibling
      // somewhere in the same dialog/popup container. Scan dialogs first,
      // then fall back to ancestor-scoped lookup for bare overlay divs.
      // Detect the popup AND tag the matched Reserve button in-place with a
      // unique data attribute so we can click that exact element afterward.
      // This avoids clicking the wrong "Reserve" if the underlying class
      // modal also exposes a Reserve button (per ACTION_SELECTORS.register).
      const tagAttr = `data-ymca-reserve-${Date.now()}`;
      const popup = await page.evaluate((tagAttr) => {
        const norm = t => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const cs = getComputedStyle(el);
          return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
        };
        const tag = (el, kind) => { el.setAttribute(tagAttr, kind); };
        const containers = [...document.querySelectorAll(
          '[role="dialog"], .modal, [class*="popup" i], [class*="overlay" i]'
        )];
        for (const c of containers) {
          const btns = [...c.querySelectorAll('button, [role="button"]')].filter(isVisible);
          if (btns.length === 0) continue;
          const reserve = btns.find(b => /^reserve$/i.test(norm(b.textContent)));
          const close   = btns.find(b => /^close$/i.test(norm(b.textContent)));
          if (reserve && close) { tag(reserve, 'container'); return { found: true, kind: 'container' }; }
        }
        // Fallback: walk up from any visible Reserve button looking for a
        // Close sibling within ~6 ancestor levels.
        const allBtns = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
        const reserveBtn = allBtns.find(b => /^reserve$/i.test(norm(b.textContent)));
        if (!reserveBtn) return { found: false };
        let node = reserveBtn.parentElement;
        for (let i = 0; i < 6 && node; i++) {
          const closeBtn = [...node.querySelectorAll('button, [role="button"]')]
            .filter(isVisible)
            .find(b => /^close$/i.test(norm(b.textContent)));
          if (closeBtn && closeBtn !== reserveBtn) { tag(reserveBtn, 'fallback'); return { found: true, kind: 'fallback' }; }
          node = node.parentElement;
        }
        return { found: false };
      }, tagAttr).catch(() => ({ found: false }));

      if (popup.found) {
        console.log(`[reserve-popup] Detected confirmation popup (${popup.kind || 'dialog'}) — clicking Reserve…`);
        try {
          // Click the exact element we tagged in evaluate() above — avoids
          // any ambiguity with a Reserve button on the underlying modal.
          const btn = page.locator(`[${tagAttr}]`).first();
          await btn.click({ timeout: 2000 });
          // Brief settle so the subsequent Stage 10E classifier sees the
          // post-Reserve DOM rather than a transient mid-render frame.
          await page.waitForTimeout(500).catch(() => {});
          // ── Task #101: post-Reserve confirmed-state polling ───────────────
          // After Reserve commits, the same popup typically updates with an
          // orange "#N On Waitlist" badge and Cancel + Close (Reserve gone).
          // Poll for that badge — or, as a fallback, a Cancel button taking
          // Reserve's place in the popup container — so we can report the
          // user's waitlist position.
          const confirm = await _pollWaitlistConfirmedState(
            page, tagAttr, popup.kind, CONFIRM_MAX_MS, CONFIRM_POLL_MS, POSITION_RE,
          );
          if (confirm.confirmedState === 'waitlisted') {
            // Forensic screenshot — captures the orange "#N On Waitlist"
            // badge so the run is auditable later. Best-effort; non-fatal.
            try {
              await captureFailureScreenshot(page, {
                jobId, phase: 'post_click', reason: 'waitlist_confirmed',
              });
            } catch (_) {}
            console.log(
              `[reserve-popup] Confirmed waitlisted${
                confirm.waitlistPosition != null ? ` (position #${confirm.waitlistPosition})` : ''
              }.`,
            );
          } else if (confirm.confirmedState === 'cancel_only') {
            console.log('[reserve-popup] Confirmed: Cancel button replaced Reserve (no position visible).');
          } else {
            console.log('[reserve-popup] Post-Reserve confirmed state did not resolve within window.');
          }
          return {
            popupSeen: true,
            clicked: true,
            confirmedState:   confirm.confirmedState,
            waitlistPosition: confirm.waitlistPosition,
          };
        } catch (clickErr) {
          console.log(`[reserve-popup] Click failed: ${clickErr.message}`);
          return {
            popupSeen: true, clicked: false, error: clickErr.message,
            confirmedState: 'unknown', waitlistPosition: null,
          };
        }
      }
      await page.waitForTimeout(POLL_MS).catch(() => {});
    }
    // No popup appeared within the window — caller continues to confirmBookingOutcome.
    return {
      popupSeen: false, clicked: false,
      confirmedState: 'unknown', waitlistPosition: null,
    };
  } catch (err) {
    return {
      popupSeen: false, clicked: false, error: err.message,
      confirmedState: 'unknown', waitlistPosition: null,
    };
  }
}

// ── Task #101 helper: post-Reserve confirmed-state polling ──────────────────
// Re-scans the popup container that originally held Reserve+Close, looking
// for the orange "#N On Waitlist" badge or a Cancel button replacing
// Reserve. Returns the first definitive confirmation seen, or
// { confirmedState: 'unknown', waitlistPosition: null } on timeout.
//
// Scope is bounded to the same container we tagged on the way in — prevents
// catching stray "on waitlist" copy elsewhere on the page.
async function _pollWaitlistConfirmedState(page, tagAttr, popupKind, maxMs, pollMs, positionRe) {
  const deadline = Date.now() + maxMs;
  const positionReSrc = positionRe.source;
  const positionReFlags = positionRe.flags;
  while (Date.now() < deadline) {
    const result = await page.evaluate((args) => {
      const { tagAttr, kind, posReSrc, posReFlags } = args;
      const norm = t => (t || '').replace(/\s+/g, ' ').trim();
      const lower = t => norm(t).toLowerCase();
      const isVisible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      };
      const positionRe = new RegExp(posReSrc, posReFlags);

      // Find the popup container we originally tagged. Prefer ancestor of
      // the tagged Reserve button; if it has been removed (Reserve replaced
      // by Cancel), fall back to scanning all dialog-like containers.
      let container = null;
      const tagged = document.querySelector(`[${tagAttr}]`);
      if (tagged) {
        container = tagged.closest('[role="dialog"], .modal, [class*="popup" i], [class*="overlay" i]')
                 || tagged.parentElement;
      }
      // Always also scan dialog-like containers — FW may unmount the tagged
      // node entirely on Reserve and remount the same popup with new content.
      const candidates = container
        ? [container]
        : [...document.querySelectorAll('[role="dialog"], .modal, [class*="popup" i], [class*="overlay" i]')];

      for (const c of candidates) {
        if (!isVisible(c)) continue;
        const text = norm(c.textContent || '');
        const m = text.match(positionRe);
        if (m) {
          const n = parseInt(m[1], 10);
          return { confirmedState: 'waitlisted', waitlistPosition: Number.isFinite(n) ? n : null };
        }
        const btns = [...c.querySelectorAll('button, [role="button"]')].filter(isVisible);
        const hasCancel  = btns.some(b => /^cancel$/i.test(lower(b.textContent)));
        const hasReserve = btns.some(b => /^reserve$/i.test(lower(b.textContent)));
        if (hasCancel && !hasReserve) {
          return { confirmedState: 'cancel_only', waitlistPosition: null };
        }
      }
      // Task #101 — code review feedback: the prior document.body fallback
      // could match unrelated "N on waitlist" copy elsewhere on the page
      // (sidebars, help text, other class rows) and misreport position.
      // Container-scoped detection above is sufficient; if no candidate
      // container exposed the badge, return null and let the poll continue.
      return null;
    }, {
      tagAttr,
      kind: popupKind,
      posReSrc: positionReSrc,
      posReFlags: positionReFlags,
    }).catch(() => null);

    if (result) return result;
    await page.waitForTimeout(pollMs).catch(() => {});
  }
  return { confirmedState: 'unknown', waitlistPosition: null };
}

// ── Post-click booking confirmation ───────────────────────────────────────────
// After clicking Register / Waitlist (and optionally a "Reserve" popup), this
// checks whether the booking actually completed on the YMCA server.
//
// Success signals (in priority order):
//   1. A "Cancel" button appeared — the modal now shows "Cancel [Waitlist]",
//      meaning you are enrolled / waitlisted.
//   2. The Register AND Waitlist buttons both disappeared — the modal state
//      changed to something other than "available to book".
//   3. Confirmation text in the page body (strict patterns only).
//
// If none of these fire, the function tries to click a "Reserve" popup once,
// then re-checks. Returns { confirmed, viaPopup, cancelFound }.
async function checkBookingConfirmed(page, _jobId, attempt, actionLabel, replayStore) {
  await _waitForConfirmSignal(page, 2000);

  async function readSignals() {
    const btns = await detectActionButtons(page);
    // Use textContent (no layout reflow) instead of innerText — confirmation
    // text patterns are insensitive to CSS visibility so this is safe here.
    const body = (await page.evaluate(() => document.body.textContent ?? '').catch(() => '')).toLowerCase();
    // Match explicit server-side confirmations. Includes FamilyWorks waitlist phrases.
    // NOTE (Apr 2026): A broader pattern set was tried and produced false
    // positives (FW page chrome contains words like "thanks"/"reserved" in
    // unrelated contexts). Reverted to the conservative pattern.
    const textConfirm = /registered|confirmed|success|you.?re registered|booking confirmed|enrollment|added to|on the waitlist|waitlisted|waitlist confirmed|you.?re on/i.test(body);
    return { btns, body, textConfirm };
  }

  const step1 = await readSignals();
  console.log(`[confirm-check] after ${actionLabel}: cancel=${step1.btns.hasCancel} register=${step1.btns.hasRegister} waitlist=${step1.btns.hasWaitlist} textOK=${step1.textConfirm}`);

  // Primary positive signal: Cancel button appeared
  if (step1.btns.hasCancel) {
    console.log(`✅ Booking confirmed (Cancel button appeared) after ${actionLabel}`);
    return { confirmed: true, viaPopup: false, cancelFound: true };
  }
  // Secondary: strict text confirmation
  if (step1.textConfirm) {
    console.log(`✅ Booking confirmed (text match) after ${actionLabel}`);
    return { confirmed: true, viaPopup: false, cancelFound: false };
  }
  // Register/Waitlist buttons gone and no Cancel — ambiguous close (schedule page?)
  // But if a "Reserve" popup button is still present → click it as the confirm step.
  if (step1.btns.hasRegister && step1.btns.registerBtn) {
    console.log(`[confirm-check] confirmation popup still open — clicking Reserve to finalize...`);
    replayStore.addEvent(_jobId, 'action_attempt', `Clicked Reserve (popup confirmation after ${actionLabel})`, `Attempt ${attempt}`);
    await step1.btns.registerBtn.first().click();
    await _waitForConfirmSignal(page, 2000);

    const step2 = await readSignals();
    console.log(`[confirm-check] after popup click: cancel=${step2.btns.hasCancel} register=${step2.btns.hasRegister} waitlist=${step2.btns.hasWaitlist} textOK=${step2.textConfirm}`);

    if (step2.btns.hasCancel) {
      console.log(`✅ Booking confirmed via popup (Cancel button appeared)`);
      return { confirmed: true, viaPopup: true, cancelFound: true };
    }
    if (step2.textConfirm) {
      console.log(`✅ Booking confirmed via popup (text match)`);
      return { confirmed: true, viaPopup: true, cancelFound: false };
    }
    // Buttons gone after popup → modal closed = booking went through.
    if (!step2.btns.hasRegister && !step2.btns.hasWaitlist) {
      console.log(`✅ Booking confirmed via popup (action buttons gone — modal closed after Reserve)`);
      return { confirmed: true, viaPopup: true, cancelFound: false };
    }
    // Register/Waitlist still present → booking did not complete.
    console.log(`⚠️ Post-popup: Register/Waitlist still present — booking did not complete.`);
    return { confirmed: false, viaPopup: true, cancelFound: false };
  }

  // No popup appeared and no Cancel/text signal yet.
  // FamilyWorks sometimes takes 2–4 s to show "Cancel" after processing —
  // wait up to 3 s but exit early if Cancel/Register state changes.
  if (!step1.btns.hasRegister && !step1.btns.hasWaitlist) {
    // Fast-bail (Task #60): if the click navigated the page OFF the schedule
    // embed (detail-page navigation), the delayed-Cancel wait will never
    // produce a signal — Cancel/Register live on the schedule embed only.
    // Skip the 3 s wait and let the detail-page handler pick up the case.
    const _curUrl = (() => { try { return page.url(); } catch { return ''; } })();
    if (_curUrl && !_curUrl.includes('schedulesembed')) {
      console.log(`[confirm-check] buttons gone AND off schedule embed (url=${_curUrl}) — fast-bail, skipping 3 s delayed-Cancel wait`);
      return { confirmed: false, viaPopup: false, cancelFound: false, weakSignal: true, offEmbed: true };
    }
    console.log(`[confirm-check] buttons gone — waiting up to 3 s for delayed Cancel/text confirmation...`);
    await _waitForConfirmSignal(page, 3000);
    const step1b = await readSignals();
    console.log(`[confirm-check] delayed re-check: cancel=${step1b.btns.hasCancel} textOK=${step1b.textConfirm}`);

    if (step1b.btns.hasCancel) {
      console.log(`✅ Booking confirmed (delayed Cancel button appeared) after ${actionLabel}`);
      return { confirmed: true, viaPopup: false, cancelFound: true };
    }
    if (step1b.textConfirm) {
      console.log(`✅ Booking confirmed (delayed text match) after ${actionLabel}`);
      return { confirmed: true, viaPopup: false, cancelFound: false };
    }

    // Still no strong signal — capture the current state as a diagnostic screenshot.
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotFile = `data/screenshots/${new Date().toISOString().slice(0,10)}/confirm-weak-${ts}.png`;
      const { mkdirSync } = require('fs');
      mkdirSync(require('path').dirname(screenshotFile), { recursive: true });
      await page.screenshot({ path: screenshotFile, fullPage: false });
      console.log(`[confirm-check] ⚠️ Weak-signal screenshot: ${screenshotFile}`);
    } catch (e) {
      console.log(`[confirm-check] Screenshot failed: ${e.message}`);
    }

    // No strong signal at all — modal closed but we cannot verify enrollment.
    // Return NOT confirmed so the retry loop re-opens the modal and checks again.
    // The reload → re-click path will re-open the modal; if Cancel appears then,
    // the attempt-loop's hasCancel guard will catch it as a true confirmation.
    console.log(`⚠️ Booking NOT confirmed (WEAK signal only — action buttons gone, no Cancel/text) after ${actionLabel}`);
    return { confirmed: false, viaPopup: false, cancelFound: false, weakSignal: true };
  }

  // Waitlist button still present but no Register and no Cancel.
  // FamilyWorks keeps showing the "Waitlist" button after a successful waitlist
  // enrollment — it does NOT change to Cancel/Leave Waitlist in the embed.
  // Wait 3 s and re-check: if the state is stable (still Waitlist-only, no Register)
  // then this IS the FW confirmation posture and we can treat it as confirmed.
  console.log(`[confirm-check] Waitlist-only state (no Register, no Cancel) — waiting 3 s to confirm FW waitlist enrollment...`);
  await page.waitForTimeout(3000);
  const stepWL = await readSignals();
  console.log(`[confirm-check] waitlist re-check: cancel=${stepWL.btns.hasCancel} register=${stepWL.btns.hasRegister} waitlist=${stepWL.btns.hasWaitlist} textOK=${stepWL.textConfirm}`);

  if (stepWL.btns.hasCancel) {
    console.log(`✅ Booking confirmed (delayed Cancel appeared) after ${actionLabel}`);
    return { confirmed: true, viaPopup: false, cancelFound: true };
  }
  if (stepWL.textConfirm) {
    console.log(`✅ Booking confirmed (delayed text match) after ${actionLabel}`);
    return { confirmed: true, viaPopup: false, cancelFound: false };
  }
  if (!stepWL.btns.hasRegister && stepWL.btns.hasWaitlist) {
    // Still Waitlist-only — this is the stable FamilyWorks "you are on the waitlist" state.
    console.log(`✅ Booking confirmed (FW waitlist-only stable state — Register gone, Waitlist present) after ${actionLabel}`);
    return { confirmed: true, viaPopup: false, cancelFound: false };
  }

  console.log(`⚠️ After ${actionLabel}: no Cancel, Register gone but Waitlist visible — state unclear after 3 s re-check, treating as incomplete (weakSignal).`);
  return { confirmed: false, viaPopup: false, cancelFound: false, weakSignal: true };
}

// ── Stage 10E: Strong post-click outcome detector ────────────────────────────
// Standalone helper called once per attempted Register/Waitlist click to
// classify the post-click DOM into a single canonical outcome with the raw
// signals that produced the verdict.
//
// Reserve path (action='register') outcomes (priority order — UNCHANGED):
//   "booked"      — Unregister / Cancel / View Reservation visible (strongest)
//   "waitlisted"  — waitlist-specific confirmation text observed
//   "still_open"  — Register button still present (click had no effect)
//   "ambiguous"   — none of the above; re-checked every 2 s for up to 10 s
//
// Waitlist path (action='waitlist') outcomes (Stage 3 truth table):
//   "auth_interrupted"   — login wall / SSO redirect during the flow
//   "booked"             — Cancel Registration / View Reservation visible
//   "already_waitlisted" — pre-click snapshot already showed waitlist marker AND
//                          post-click still shows it (idempotent click)
//   "waitlist_joined"    — Leave/View Waitlist OR position text OR explicit
//                          confirmation text, confirmed across two polls
//                          (RECHECK_OK) — or single positive read at timeout
//   "no_state_change"    — Register/Waitlist button persists AND body+url+button
//                          set is byte-identical to the pre-click snapshot AND
//                          settle window (≥ 6 s) has elapsed
//   "ambiguous"          — modal closed but no row badge, OR partial change
//                          without resolving signal, OR poll budget exhausted
//
// IMPORTANT: a persistent Register/Waitlist button alone is NOT evidence the
// waitlist click failed. FamilyWorks reuses the same button label after a
// successful waitlist enrollment (documented at confirmBookingActuallyHappened
// L374-378). Only the 3-way conjunction in the no_state_change rule treats
// button persistence as failure.
//
// Returns { finalOutcome, confirmationSignals } — confirmationSignals records
// the raw button + text observations used for classification, the attempted
// action, when the check ran, and how long it took. This object is surfaced
// on the run result and persisted to sniper-state so the readiness bundle
// shows the verified booking outcome.
async function confirmBookingOutcome(page, action, scope = null, preClickSnapshot = null) {
  const POLL_INTERVAL_MS = 2000;
  const MAX_TOTAL_MS     = 10000;
  const SETTLE_MIN_MS    = 6000;
  const startedAt        = Date.now();

  async function readSignalsOnce() {
    // Scope button detection to the open modal (if still attached) to avoid
    // picking up Register/Cancel buttons elsewhere on the schedule page.
    // Falls back to page-wide automatically when the scope element detached.
    let _scope = scope;
    let _modalGone = false;
    if (_scope) {
      try {
        const cnt = await _scope.count();
        if (cnt === 0) { _scope = null; _modalGone = true; }
      } catch { _scope = null; _modalGone = true; }
    }
    const btns = await detectActionButtons(page, _scope).catch(() => ({
      hasCancel: false, hasRegister: false, hasWaitlist: false, allBtnTexts: [],
    }));
    const body = (await page.evaluate(() => document.body.textContent ?? '').catch(() => '')).toLowerCase();
    const url  = page.url();
    const btnTexts = btns.allBtnTexts || [];

    const waitlistText =
      /\bon the waitlist\b|\bwaitlisted\b|\bwaitlist confirmed\b|you.?re on the waitlist|joined (the )?waitlist|added to (the )?waitlist/i.test(body);
    const waitlistPosition =
      /#?\s*\d+\s*(?:on|in|of)?\s*(?:the\s*)?wait[\s-]?list|waitlist\s*position\s*[:#]?\s*\d+|position\s*[:#]?\s*\d+\s*on\s*(?:the\s*)?waitlist/i.test(body);
    const cancelText =
      /\bcancel registration\b|\bview reservation\b|\bunregister\b/i.test(body);
    const leaveWaitlistText =
      /\bleave waitlist\b|\bview waitlist\b|\bcancel waitlist\b|\bremove from waitlist\b/i.test(body);
    const leaveWaitlistButton = btnTexts.some(
      t => /leave\s*waitlist|view\s*waitlist|cancel\s*waitlist|remove\s*from\s*waitlist|unregister/i.test(t)
    );

    // Auth wall detection — URL pattern OR visible password/login form
    const authUrlHit = /\/login|\/sso|\/signin|daxko[-_]?login|account\.daxko/i.test(url);
    let authForm = false;
    try {
      authForm = (await page.locator(
        'input[type="password"]:visible, h1:has-text("Sign in"), h1:has-text("Log in")'
      ).count().catch(() => 0)) > 0;
    } catch { /* ignore */ }
    const authWall = authUrlHit || authForm;

    // Body-unchanged compare against pre-click snapshot
    let bodyUnchanged = false;
    if (preClickSnapshot && preClickSnapshot.hash) {
      const currentHash = `${url}|${(body || '').slice(0, 2000)}|${[...btnTexts].sort().join(',')}`;
      bodyUnchanged = currentHash === preClickSnapshot.hash;
    }

    return {
      hasUnregisterButton: !!btns.hasCancel || cancelText,
      hasWaitlistText:     waitlistText,
      hasWaitlistPosition: waitlistPosition,
      hasLeaveWaitlist:    leaveWaitlistButton || leaveWaitlistText,
      hasRegisterButton:   !!btns.hasRegister,
      hasWaitlistButton:   !!btns.hasWaitlist,
      visibleButtons:      btnTexts,
      modalGone:           _modalGone,
      authWall,
      bodyUnchanged,
      url,
    };
  }

  // Reserve-path classifier — UNCHANGED behavior from prior Stage 10E
  function classifyRegister(sig) {
    if (sig.hasUnregisterButton) return 'booked';
    if (sig.hasWaitlistText)     return 'waitlisted';
    if (sig.hasRegisterButton)   return 'still_open';
    return 'ambiguous';
  }

  // Waitlist-path classifier — Stage 3 truth table.
  // Returns { outcome, positive } where `positive` arms the RECHECK_OK gate
  // for waitlist_joined. A pending positive uses the sentinel '__pending_positive'.
  function classifyWaitlist(sig, prevPositive) {
    if (sig.authWall)            return { outcome: 'auth_interrupted', positive: false };
    if (sig.hasUnregisterButton) return { outcome: 'booked',           positive: false };

    const positiveWL = sig.hasLeaveWaitlist || sig.hasWaitlistPosition || sig.hasWaitlistText;

    // already_waitlisted — pre-click snapshot already showed a waitlist marker
    // AND post-click still shows the same kind of marker. Idempotent click.
    if (preClickSnapshot && preClickSnapshot.hadWaitlistMarker && positiveWL) {
      return { outcome: 'already_waitlisted', positive: false };
    }

    // waitlist_joined — gated by RECHECK_OK (two consecutive positive reads)
    if (positiveWL) {
      if (prevPositive) return { outcome: 'waitlist_joined',     positive: true };
      return                  { outcome: '__pending_positive',   positive: true };
    }

    // Modal closed without auth wall and no positive marker → ambiguous
    // (FW may have closed the modal as part of a successful join, or the
    // click silently dismissed it — we cannot tell apart without ROW_BADGE)
    if (sig.modalGone) return { outcome: 'ambiguous', positive: false };

    // True no_state_change requires the 3-way conjunction:
    // button persists AND body byte-identical AND settle window elapsed.
    const elapsed = Date.now() - startedAt;
    const buttonsPersist = sig.hasRegisterButton || sig.hasWaitlistButton;
    if (buttonsPersist && sig.bodyUnchanged && elapsed >= SETTLE_MIN_MS) {
      return { outcome: 'no_state_change', positive: false };
    }

    return { outcome: 'ambiguous', positive: false };
  }

  let signals = await readSignalsOnce();
  let outcome;
  let prevPositive = false;

  if (action === 'waitlist') {
    let r = classifyWaitlist(signals, prevPositive);
    outcome = r.outcome;
    prevPositive = r.positive;

    while ((outcome === 'ambiguous' || outcome === '__pending_positive') &&
           (Date.now() - startedAt) < MAX_TOTAL_MS) {
      await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => {});
      signals = await readSignalsOnce();
      r = classifyWaitlist(signals, prevPositive);
      outcome = r.outcome;
      prevPositive = r.positive;
    }
    // A single positive read at timeout is more truthful than 'ambiguous'
    // (FW may simply not flicker the marker a second time within 10 s).
    if (outcome === '__pending_positive') outcome = 'waitlist_joined';
  } else {
    outcome = classifyRegister(signals);
    while (outcome === 'ambiguous' && (Date.now() - startedAt) < MAX_TOTAL_MS) {
      await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => {});
      signals = await readSignalsOnce();
      outcome = classifyRegister(signals);
    }
  }

  return {
    finalOutcome: outcome,
    confirmationSignals: {
      action,
      hasUnregisterButton:  signals.hasUnregisterButton,
      hasWaitlistText:      signals.hasWaitlistText,
      hasWaitlistPosition:  signals.hasWaitlistPosition,
      hasLeaveWaitlist:     signals.hasLeaveWaitlist,
      hasRegisterButton:    signals.hasRegisterButton,
      hasWaitlistButton:    signals.hasWaitlistButton,
      visibleButtons:       signals.visibleButtons,
      modalGone:            signals.modalGone,
      authWall:             signals.authWall,
      bodyUnchanged:        signals.bodyUnchanged,
      preClickSnapshotUsed: !!preClickSnapshot,
      checkedAt:            new Date().toISOString(),
      elapsedMs:            Date.now() - startedAt,
    },
  };
}

// ── Stage 4: operator-facing labels for waitlist post-click outcomes ─────────
// Used by the waitlist call sites to produce truthful, human-readable labels
// and one-line messages for the failure feed in Tools and run summaries.
// Keyed on the canonical finalOutcome strings emitted by confirmBookingOutcome.
const WAITLIST_OUTCOME_LABEL = {
  waitlist_joined:    'Waitlist joined',
  already_waitlisted: 'Already on waitlist',
  no_state_change:    'No state change after waitlist click',
  ambiguous:          'Waitlist outcome ambiguous',
  auth_interrupted:   'Auth interrupted during waitlist flow',
  // Backward compat (rare on waitlist path; surfaced if confirmBookingOutcome
  // returns the reserve-path strings on a waitlist action):
  booked:             'Registered (Cancel button visible)',
  waitlisted:         'Waitlist confirmed',
  still_open:         'No state change after waitlist click',
};
const WAITLIST_OUTCOME_MESSAGE = {
  waitlist_joined:    'Click landed on the waitlist (verified by waitlist marker after the click).',
  already_waitlisted: 'You were already on the waitlist before the click — nothing more to do.',
  no_state_change:    'Click did not change the page (button persists, body and URL unchanged after settle).',
  ambiguous:          'Click happened but no waitlist marker resolved within the 10 s window.',
  auth_interrupted:   'A login wall appeared during the waitlist flow — sign in required to confirm.',
  booked:             'Reserve-path success indicator appeared after the waitlist click.',
  waitlisted:         'Waitlist confirmation text observed after the click.',
  still_open:         'Click did not visibly change the page within the 10 s window.',
};
function _waitlistLabel(outcome, position) {
  const base = WAITLIST_OUTCOME_LABEL[outcome] || `Waitlist outcome: ${outcome}`;
  // Task #101 — append the FW position number when known. Only meaningful
  // for the "joined" / "already on waitlist" success outcomes; harmless if
  // position is null.
  if (position != null && Number.isFinite(position)) return `${base} · #${position}`;
  return base;
}
function _waitlistMessage(outcome, position) {
  const base = WAITLIST_OUTCOME_MESSAGE[outcome] || `Waitlist post-click outcome was "${outcome}".`;
  if (position != null && Number.isFinite(position)) {
    return `${base} You are #${position} on the waitlist.`;
  }
  return base;
}

// ── Stage 3: pre-click snapshot helper ───────────────────────────────────────
// Captures a compact fingerprint of the modal/page state immediately BEFORE a
// waitlist click so the post-click classifier can:
//   1. Detect already_waitlisted (snapshot.hadWaitlistMarker = true)
//   2. Detect no_state_change (snapshot.hash byte-identical post-click)
// Returns null on any failure — confirmBookingOutcome handles a null snapshot
// gracefully (skips both signals, behaves like single-read classifier).
async function capturePreClickSnapshot(page, scope) {
  try {
    const url = page.url();
    const body = (await page.evaluate(() => document.body.textContent ?? '').catch(() => '')).toLowerCase();
    const btns = await detectActionButtons(page, scope).catch(() => ({ allBtnTexts: [] }));
    const btnTexts = btns.allBtnTexts || [];
    const hadWaitlistMarker =
      /\bleave waitlist\b|\bview waitlist\b|\bcancel waitlist\b|#?\s*\d+\s*(?:on|in|of)?\s*(?:the\s*)?wait[\s-]?list|\bon the waitlist\b|\bwaitlisted\b/i.test(body) ||
      btnTexts.some(t => /leave\s*waitlist|view\s*waitlist|cancel\s*waitlist|remove\s*from\s*waitlist/i.test(t));
    const hash = `${url}|${(body || '').slice(0, 2000)}|${[...btnTexts].sort().join(',')}`;
    return { hash, url, hadWaitlistMarker, capturedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

// ── Inline Familyworks authentication ─────────────────────────────────────
// Called when a booking modal shows "Login to Register" despite a successful
// Daxko login.  Clicks the button, handles whatever login flow appears
// (Daxko SSO redirect or a Familyworks-native form), and returns an outcome.
// Non-throwing — the caller decides how to handle failure.
async function attemptInlineAuth(page) {
  try {
    console.log('[inline-auth] "Login to Register" detected — attempting inline auth...');

    const SCHEDULE_URL = 'https://my.familyworks.app/schedulesembed/eugeneymca?search=yes';

    // Click the Login to Register button inside the modal
    const loginBtn = page.locator(
      'button:has-text("Login to Register"), [role="button"]:has-text("Login to Register"), a:has-text("Login to Register")'
    ).first();
    if ((await loginBtn.count()) === 0) {
      return { authenticated: false, detail: 'Login to Register button not found in modal' };
    }
    // Click and simultaneously wait for any navigation (Daxko redirect).
    // Using Promise.all avoids a race where navigation finishes before
    // waitForNavigation is registered.  Fallback 5s covers slow networks.
    await Promise.all([
      page.waitForNavigation({ timeout: 5000, waitUntil: 'domcontentloaded' }).catch(() => {}),
      loginBtn.click(),
    ]);

    const afterClickUrl = page.url();
    console.log('[inline-auth] After click, URL:', afterClickUrl);

    const isOnDaxkoLogin   = afterClickUrl.includes('daxko.com') && afterClickUrl.includes('find_account');
    const isOnDaxkoAccount = afterClickUrl.includes('daxko.com') &&
                             (afterClickUrl.includes('MyAccount') || afterClickUrl.includes('myaccount'));

    if (isOnDaxkoLogin) {
      // SSO redirected to Daxko login — fill credentials
      console.log('[inline-auth] SSO redirect to Daxko login — completing SSO...');
      await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
      await page.click('#submit_button');
      await page.waitForTimeout(1500);
      if ((await page.locator('input[type="password"]').count()) > 0) {
        await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
        await page.click('#submit_button');
      }
      // Wait for redirect back to FamilyWorks (y_login callback sets the session cookie)
      await page.waitForURL(url => url.toString().includes('familyworks'), { timeout: 12000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      console.log('[inline-auth] SSO complete. URL:', page.url());

      // After the y_login callback, navigate back to the schedule embed.
      // This ensures the retry loop's page.reload() reloads the schedule
      // (not the y_login callback URL which would show an error/404).
      if (!page.url().includes('schedulesembed')) {
        console.log('[inline-auth] Navigating back to schedule embed after OAuth...');
        await page.goto(SCHEDULE_URL, { timeout: 20000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        console.log('[inline-auth] Back on schedule. URL:', page.url());
      }

      return {
        authenticated: true,
        renavigated:   true,
        detail:        'Completed Daxko SSO redirect after Login to Register — back on schedule embed',
      };
    }

    if (isOnDaxkoAccount) {
      // Clicked "Login to Register" but we're already authenticated with Daxko.
      // The booking modal's OAuth request redirected to the Daxko account page
      // instead of back to FamilyWorks. Wait for an automatic redirect to FW.
      console.log('[inline-auth] On Daxko account page (already authenticated) — waiting for OAuth redirect to FamilyWorks...');
      try {
        // Daxko→FW redirect is usually near-instant when already authed; 4 s is ample.
        await page.waitForURL(url => url.toString().includes('familyworks.app'), { timeout: 4000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log('[inline-auth] OAuth redirect to FamilyWorks succeeded. URL:', page.url());
        return { authenticated: true, detail: 'OAuth redirect from Daxko account page completed — back on FamilyWorks' };
      } catch {
        // No automatic redirect — navigate back to FamilyWorks schedule manually.
        // The FamilyWorks session cookie may now be set after the Daxko handshake.
        // The booking loop's existing retry logic will reload, re-find the card,
        // and re-click it. On the next attempt the modal should show Register/Waitlist.
        console.log('[inline-auth] No automatic OAuth redirect — navigating back to FamilyWorks schedule...');
        await page.goto(SCHEDULE_URL, { timeout: 20000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        console.log('[inline-auth] Back on FamilyWorks. URL:', page.url());
        return {
          authenticated: true,
          renavigated: true,
          detail: 'Navigated back to FamilyWorks after Daxko account page — retry loop will reopen modal',
        };
      }
    }

    // Look for a login form on the current page (Familyworks-native)
    const emailInput = page.locator('input[type="email"], input[type="text"]').first();
    if ((await emailInput.count()) > 0) {
      console.log('[inline-auth] Login form found — filling credentials...');
      await emailInput.fill(process.env.YMCA_EMAIL || '');
      // Multi-step: first "Continue / Next" button
      const nextBtn = page.locator(
        'button:has-text("Continue"), button:has-text("Next"), #submit_button'
      ).first();
      if ((await nextBtn.count()) > 0) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      }
      const passField = page.locator('input[type="password"]').first();
      if ((await passField.count()) > 0) {
        await passField.fill(process.env.YMCA_PASSWORD || '');
        const submitBtn = page.locator(
          'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In")'
        ).first();
        if ((await submitBtn.count()) > 0) {
          await submitBtn.click();
          await page.waitForTimeout(4000);
          console.log('[inline-auth] Login submitted. URL:', page.url());
        }
      }
      return { authenticated: true, detail: 'Submitted inline login form' };
    }

    return { authenticated: false, detail: 'No SSO redirect or login form detected after clicking Login to Register' };
  } catch (err) {
    return { authenticated: false, detail: `Inline auth error: ${err.message}` };
  }
}

const isHeadless = process.env.HEADLESS !== 'false';

// Production: false.  When true, the bot outlines the click target in the live
// browser and appends a floating "CLICK TARGET" label — both visible in
// screenshots.  Useful for local debug, but in production it adds ~2 s per
// click via an elementHandle() wait that often times out on Bubble re-renders.
const DEBUG_HIGHLIGHT = false;

// Set to true (+ run with HEADLESS=false) to open Playwright Inspector just
// before the card click. page.pause() is a no-op in headless mode, so this
// has zero effect on normal / production runs even if accidentally left true.
const DEBUG_PAUSE = false;

// When true, capture additional screenshots at key milestone points
// (auth confirmed, schedule loaded, card found, modal opened) so a full
// visual breadcrumb is available for debugging.
// Activate with: DEBUG_SCREENSHOTS=true npm start
// Default (false) = failure + uncertain states only — production-safe.
const DEBUG_SCREENSHOTS = process.env.DEBUG_SCREENSHOTS === 'true';

async function highlightElement(page, locator) {
  try {
    const el = await locator.elementHandle({ timeout: 2000 });
    if (!el) return;
    await page.evaluate((node) => {
      node.style.outline = '3px solid red';
      node.style.backgroundColor = 'rgba(255,0,0,0.1)';
      node.style.transition = 'all 0.2s ease';
      // Floating label so it shows up clearly in screenshots.
      const tag = document.createElement('div');
      tag.className = '__pw_debug_label__';
      tag.textContent = 'CLICK TARGET';
      Object.assign(tag.style, {
        position: 'fixed',
        background: 'red',
        color: 'white',
        fontSize: '11px',
        fontWeight: 'bold',
        padding: '2px 6px',
        borderRadius: '3px',
        zIndex: '999999',
        pointerEvents: 'none',
      });
      const rect = node.getBoundingClientRect();
      tag.style.top  = Math.max(0, rect.top  - 20) + 'px';
      tag.style.left = Math.max(0, rect.left)       + 'px';
      document.body.appendChild(tag);
    }, el);
  } catch (e) { console.log('highlight skipped:', e.message); }
}

async function runBookingJob(job, opts = {}) {
  const DRY_RUN       = opts.dryRun       !== undefined ? !!opts.dryRun       : (process.env.DRY_RUN === '1');
  const PREFLIGHT_ONLY = opts.preflightOnly !== undefined ? !!opts.preflightOnly : false;
  if (DRY_RUN)        console.log('--- DRY RUN MODE: will not click Register/Waitlist ---');
  if (PREFLIGHT_ONLY) console.log('--- PREFLIGHT MODE: will check readiness but NOT book ---');
  const { classTitle, classTime, instructor, dayOfWeek, targetDate, maxAttempts: maxAttemptsOpt } = job;

  // ── Readiness state for this run (taxonomy integration) ─────────────────────
  const _state = createRunState(job.id || job.jobId || null);

  // ── Replay capture — observer variables (Stage 2) ────────────────────────────
  const _jobId = String(job.id || job.jobId || 0);
  let _replayAction = null;  // 'register' | 'waitlist' | null
  if (!PREFLIGHT_ONLY) replayStore.startRun(_jobId, new Date().toISOString());

  // ── Run-context flags — set during the run, read at logRunSummary ────────────
  // filtersFailed: true when BOTH category and instructor filters had no effect,
  // meaning the scan ran on unfiltered or wrong-category schedule content.
  // Carried through to the final logRunSummary() call so outcomes like
  // 'not_found' can be re-classified when they are not trustworthy.
  let filtersFailed = false;

  // ── Self-Healing / Safe Recovery Pass — Stage 3 ─────────────────────────────
  // Bounded counter for the page-reset healing layer. The heal layer is allowed
  // to fire at most ONCE per run for each unhealthy class (filters_failed,
  // transient_empty, stale schedule shell). Healing actions are reload + filter
  // re-application + bounded settle — NEVER a Register click. If healing does
  // not restore trust, the existing truthful failure classification is preserved
  // (we just fall through to the original failure path unchanged).
  let _pageHealAttempts = 0;

  // ── Timing capture — filled in during the sniper poll and action phases ──────
  // Written to _state.timing at the end of the run so it persists to the UI.
  // Stage 2 (timing markers): every major phase is now timestamped so metrics
  // can be derived in Stage 3.  All values are ISO strings (or null if the
  // phase was not reached).  run_start is always set at entry.
  const _tc = {
    // ── Entry ──────────────────────────────────────────────────────────────
    run_start:                  new Date().toISOString(),
    // ── Auth / session ─────────────────────────────────────────────────────
    session_ping_start:         null,
    session_ping_done:          null,
    browser_launch_start:       null,
    browser_launch_done:        null,
    // ── Navigation ─────────────────────────────────────────────────────────
    page_nav_start:             null,
    page_nav_done:              null,
    // ── Filter application ─────────────────────────────────────────────────
    filter_apply_start:         null, // ISO: just before first selectOption call
    filter_apply_done:          null, // ISO: just after both filter calls complete
    // ── Class discovery ────────────────────────────────────────────────────
    class_discovery_start:      null,
    class_discovery_done:       null,
    // ── Modal open ─────────────────────────────────────────────────────────
    modal_open_start:           null,
    modal_open_done:            null,
    // ── Card click / modal wait / verify sub-markers ────────────────────────
    card_click_start:           null, // ISO: just before clickTarget.click()
    card_click_done:            null, // ISO: just after click fires (before modal wait)
    modal_wait_start:           null, // ISO: when waitForSelector(modalReady) starts
    modal_wait_done:            null, // ISO: when waitForSelector resolves / times out
    modal_verify_start:         null, // ISO: just before body.innerText() extraction
    modal_verify_done:          null, // ISO: just after verification strings computed
    // ── Modal → action-ready gap markers ──────────────────────────────────
    modal_ready_at:             null, // ISO: waitForSelector(modalReady) resolved — BEFORE settle
    action_ready_at:            null, // ISO: detectActionButtons() returned a usable btn (attempt 1)
    // ── Action attempt (first) ─────────────────────────────────────────────
    first_click_attempt_start:  null,
    first_click_attempt_done:   null,
    // ── Action attempt (per-attempt; overwritten each iteration) ───────────
    action_attempt_start:       null,
    action_attempt_done:        null,
    // ── Confirmation check (per-attempt; overwritten each iteration) ───────
    confirmation_check_start:   null,
    confirmation_check_done:    null,
    // ── Legacy fields (kept for backward compat with UI readers) ───────────
    bookingOpenAt:              null, // ISO: when booking window was scheduled to open
    cardFoundAt:                null, // ISO: when the class card appeared after open
    actionClickAt:              null, // ISO: when Register/Waitlist was actually clicked
    pollAttemptsPostOpen:       0,    // tab re-clicks that happened at or after open time
    // ── Final outcome ──────────────────────────────────────────────────────
    final_outcome:              null, // status string from logRunSummary
  };

  // Convert "Wednesday" → "Wed" to match tab labels like "Wed 02"
  const DAY_SHORT = {
    Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
    Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat',
  };
  let dayShort = DAY_SHORT[dayOfWeek] || 'Wed';

  // If targetDate is provided (YYYY-MM-DD), derive the exact day number and
  // override dayShort from the date itself.  target_date is ALWAYS the single
  // source of truth for tab selection — day_of_week is never used when
  // target_date is present, even if the two fields disagree.
  let targetDayNum = null;

  // Consistency check — hoisted so _wc is available for error messages later.
  // Compares stored day_of_week against the actual calendar weekday of target_date.
  const _wc = checkJobConsistency(job);

  // Pre-built diagnostic prefix prepended to not_found messages when the job
  // data is inconsistent — tells the user exactly what disagreed and why.
  // Format: "Job inconsistency: stored weekday Tuesday does not match
  //          target_date Thursday Apr 23. "
  const _wcPrefix = (_wc && !_wc.isConsistent && targetDate)
    ? (() => {
        const dateLabel = new Date(targetDate + 'T12:00:00Z')
          .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        return `Job inconsistency: stored weekday ${_wc.storedWeekday} does not match target_date ${_wc.computedWeekday} ${dateLabel}. `;
      })()
    : '';

  if (targetDate) {
    const d = new Date(targetDate + 'T00:00:00Z'); // parse as UTC to avoid tz shift
    dayShort     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    targetDayNum = d.getUTCDate(); // numeric day-of-month, e.g. 9

    if (!_wc.isConsistent) {
      console.warn(
        `[job-consistency] runBookingJob: stored day_of_week "${dayOfWeek}" ` +
        `does not match target_date ${targetDate} (${_wc.computedWeekday}). ` +
        `Tab selection will use "${dayShort} ${targetDayNum}" from target_date — ` +
        `ignoring stale day_of_week label.`
      );
    }

    console.log(`targetDate: ${targetDate} → looking for "${dayShort} ${targetDayNum}" tab`);
  }
  const classTitleLower = classTitle.toLowerCase();
  // Normalize DB time "7:45 AM" → "7:45 a" to match page text like "7:45 a - 8:45 a"
  const classTimeNorm = classTime
    ? classTime.trim().toLowerCase().replace(/^(\d+:\d+)\s*(am|pm).*/, (_, t, ap) => t + ' ' + ap[0])
    : null;
  // First name only for fuzzy instructor matching ("Stephanie Sanders" → "stephanie").
  // null means no instructor was specified on the job — skip instructor verification.
  const instructorFirstName = instructor
    ? instructor.trim().split(/\s+/)[0].toLowerCase()
    : null;
  let browser;
  let screenshotPath      = null;
  let _authLockAcquired   = false;
  let _lastBestScore   = 0;
  let _lastBestText    = '';
  let _lastSecondCard  = null;
  // Populated by findTargetCard() when the matched row explicitly shows
  // capacity state ('full' | 'waitlist') in the schedule-page text.
  // Checked before attemptClickAndVerify() to bail early without clicking.
  let _rowCapacityFromSchedule = null;
  let _lastSecondScore = 0;
  let _lastSecondText  = '';
  let _lastModalPreview = '';
  let _lastBestReasons = [];   // reasons array from last findTargetCard() hit
  let _lastAllTexts    = [];   // allTexts from last findTargetCard() miss
  // Set by applyFilterBySelectIndex when the schedule panel still has 0 cards
  // after a polled wait — distinguishes "filter had no effect" from "schedule
  // wasn't rendered yet" so the caller can skip the noisy unfiltered fallback
  // and let the retry loop re-attempt with a fresh page state. (Task #59)
  let _scheduleNotLoaded = false;

  // logRunSummary — defined before the try block so it is in scope for both
  // the try body and the catch handler.  Returns `result` so it can be inlined:
  //   return logRunSummary({ status: '...', message: '...', screenshotPath });
  function logRunSummary(result) {
    // Attach the run-level screenshot ref to the persisted state so UI can access it.
    const _ref = _screenshotRef(screenshotPath);
    if (_ref) _state.screenshotPath = _ref;
    // Stage 2: record the final outcome status in the timing context.
    if (!_tc.final_outcome) _tc.final_outcome = result.status ?? null;

    console.log('\n--- RUN SUMMARY ---');
    console.log(JSON.stringify({
      contextTimezone:   'America/Los_Angeles',
      expectedTime:      classTimeNorm || classTime || '(unknown)',
      matchedRowScore:   _lastBestScore,
      matchedRowPreview: _lastBestText     ? _lastBestText.slice(0, 100)     : '(no match)',
      modalTimePreview:  _lastModalPreview || '(no modal opened)',
      finalStatus:       result.status,
      phase:             result.phase    || '(untagged)',
      reason:            result.reason   || '(untagged)',
      category:          result.category || '(untagged)',
    }, null, 2));
    console.log('-------------------\n');

    // Persist structured failure to SQLite — but skip if the failure was already
    // recorded inline (result.recorded === true) to avoid duplicate rows.
    if (['error', 'not_found'].includes(result.status) && result.phase && result.reason && !result.recorded) {
      recordFailure({
        jobId:      job.id || job.jobId || null,
        phase:      result.phase,
        reason:     result.reason,
        category:   result.category  || null,
        label:      result.label     || null,
        message:    result.message   || null,
        classTitle: classTitle       || null,
        screenshot: _screenshotRef(screenshotPath),
        expected:   result.expected  || null,
        actual:     result.actual    || null,
        url:        result.url       || null,
        context:    result.context   || null,
      });
    }

    // ── Replay: finish run — outcome derived from result status + action taken ──
    if (!PREFLIGHT_ONLY) {
      const replayOutcome =
        (result.status === 'booked' || result.status === 'success') && _replayAction === 'waitlist' ? 'waitlist' :
        (result.status === 'booked' || result.status === 'success')                                  ? 'success'  :
        'failure';
      replayStore.finishRun(_jobId, replayOutcome);
    }
    // ─────────────────────────────────────────────────────────────────────────

    return result;
  }

  try {
    // ── POINT 1: System validation ───────────────────────────────────────────
    if (!classTitle) {
      return logRunSummary({
        status: 'error', message: 'Job is missing required classTitle field',
        screenshotPath, phase: 'system', reason: 'invalid_job_params',
        category: 'system', label: 'Invalid job parameters',
        context: { receivedKeys: Object.keys(job) },
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Use the shared session module: launches Chromium, logs in to Daxko,
    // and verifies the auth cookie before returning.
    const _runSource = PREFLIGHT_ONLY ? 'preflight' : 'booking';

    advance(_state, 'AUTH');

    // ── Tier-2 pre-check (no lock needed) ────────────────────────────────────
    // Run a fast HTTP ping first.  If it passes, the session is valid and no
    // credentials will be used — the auth lock is never acquired.  Only when
    // the ping misses do we need to do a full Playwright sign-in (and only
    // then do we need to hold the lock to prevent concurrent auth attempts).
    let _tier2Trusted = false;
    let _pingResult   = null;
    try {
      _tc.session_ping_start = new Date().toISOString();
      _pingResult   = await pingSessionHttp();
      _tc.session_ping_done  = new Date().toISOString();
      _tier2Trusted = _pingResult.trusted === true;
      if (_tier2Trusted) {
        console.log(`[auth-lock] ${_runSource} — Tier-2 ping trusted, skipping auth lock.`);
      } else {
        console.log(`[auth-lock] ${_runSource} — Tier-2 ping miss (${_pingResult.detail}), will need full auth.`);
      }
    } catch (pingErr) {
      console.log(`[auth-lock] ${_runSource} — Tier-2 ping error (${pingErr.message}), falling back to full auth.`);
    }

    // ── Preflight ping-timeout guard ──────────────────────────────────────────
    // When BOTH HTTP pings time out simultaneously (network blip, YMCA site
    // slow), skip browser auth in preflight mode.  A preflight is a health
    // check — deferring it is always safe.  Without this guard a 20s ping
    // timeout cascades into a 120s+ browser auth that holds the auth lock and
    // makes the server unresponsive to API calls for the entire window.
    if (PREFLIGHT_ONLY && !_tier2Trusted && _pingResult) {
      const daxkoTimedOut = _pingResult.daxkoResult?.valid === null;
      const fwTimedOut    = _pingResult.fwResult?.valid    === null;
      if (daxkoTimedOut && fwTimedOut) {
        console.log(`[auth-lock] ${_runSource} — both pings timed out; skipping browser auth in preflight mode.`);
        return logRunSummary({
          status:   'session_uncertain',
          message:  'HTTP pings timed out — session state unknown (network blip); deferring preflight',
          screenshotPath,
          phase:    'auth',
          reason:   'ping_timeout',
          category: 'auth',
          label:    'Session uncertain (ping timeout)',
        });
      }
    }

    // ── Auth lock — only when credentials are actually needed ─────────────────
    if (!_tier2Trusted) {
      // Guard: if another auth operation is already running, skip this run.
      if (isLocked()) {
        console.log(`[auth-lock] ${_runSource} skipped — auth lock held. Another browser session is in progress.`);
        return logRunSummary({ status: 'error', message: 'Auth lock held — concurrent login already in progress', screenshotPath, phase: 'auth', reason: 'concurrent_auth', category: 'system', label: 'Auth lock held by another process' });
      }
      _authLockAcquired = acquireLock(_runSource, 'signing_in');
    }

    let _session;
    try {
      _tc.browser_launch_start = new Date().toISOString();
      // Task #71 — gate the page.goto retry on "not past booking open" so we
      // never spend a second 60 s budget while the click race is already on.
      // Pass a callback so the check is re-evaluated at the retry decision
      // point (after the first 60 s attempt) rather than frozen at session
      // creation time — booking open may have arrived during attempt 1.
      let _bookingOpenMs = null;
      try {
        const { bookingOpen: _bo } = getBookingWindow(job);
        _bookingOpenMs = _bo ? _bo.getTime() : null;
      } catch (_) { /* leave null — retry permitted */ }
      const _pastBookingOpenFn = () =>
        _bookingOpenMs != null && Date.now() >= _bookingOpenMs;
      _session = await createSession({ headless: isHeadless, pastBookingOpen: _pastBookingOpenFn });
      _tc.browser_launch_done  = new Date().toISOString();
      // Auth succeeded — update session-status.json so the UI reflects the fresh result.
      saveSessionStatus({
        valid:     true,
        checkedAt: new Date().toISOString(),
        source:    _runSource,
        detail:    'Daxko login succeeded',
        screenshot: null,
      });
      // Close the write gap identified in the post-auth-unification audit:
      // session-status.json was updated above but auth-state.json was not,
      // leaving canonical auth truth stale until FW modal detection at line ~2016.
      // Writing daxkoValid:true here immediately so canonical truth reflects the
      // successful Daxko login even if the run crashes before reaching the modal.
      // Task #79: also mirror display-only detail/screenshot so /api/session-status
      // can render them without reading session-status.json.
      updateAuthState({
        daxkoValid:          true,
        lastCheckedAt:       Date.now(),
        lastFailureType:     null,
        lastCheckDetail:     'Daxko login succeeded',
        lastCheckScreenshot: null,
      });
    } catch (loginErr) {
      // Distinguish transient timeouts from real auth failures.
      // A Playwright page-load timeout means the YMCA site was slow — credentials
      // may still be valid.  Writing valid:false for a timeout triggers a 20-min
      // skip window in preflight-loop, which is far too aggressive for a network
      // hiccup.  We tag these as failureType:'timeout' so the skip window is
      // capped at 5 min instead.
      const isTimeout = /timeout|timed out/i.test(loginErr.message);
      saveSessionStatus({
        valid:       false,
        failureType: isTimeout ? 'timeout' : 'auth_failed',
        checkedAt:   new Date().toISOString(),
        source:      _runSource,
        detail:      loginErr.message || 'Login failed',
        screenshot:  loginErr.screenshotPath ? path.basename(loginErr.screenshotPath) : null,
      });
      // Close the write gap: session-status.json was just updated above but
      // auth-state.json was not, leaving canonical auth truth stale.
      // familyworksValid is intentionally not set here — Daxko failed before
      // the FW check ran, so we have no new information about FW state.
      // Task #79: also mirror display-only detail/screenshot so /api/session-status
      // can render them without reading session-status.json.
      updateAuthState({
        daxkoValid:          false,
        lastCheckedAt:       Date.now(),
        lastFailureType:     isTimeout ? 'timeout' : 'auth_failed',
        lastCheckDetail:     loginErr.message || 'Login failed',
        lastCheckScreenshot: loginErr.screenshotPath ? path.basename(loginErr.screenshotPath) : null,
      });
      emitEvent(_state, 'AUTH', 'AUTH_LOGIN_FAILED', loginErr.message, {
        screenshot: loginErr.screenshotPath ? path.basename(loginErr.screenshotPath) : null,
        evidence: {
          provider: 'Daxko',
          detail:   (loginErr.message || 'Login failed').slice(0, 120),
        }
      });
      // Task #71 — distinguish auth-phase page.goto timeouts from real
      // credential failures so the noise-reduction taxonomy can classify
      // them as transient (auth_timeout ∈ TRANSIENT_REASONS).
      const _reason = isTimeout ? 'auth_timeout' : 'login_failed';
      const _label  = isTimeout ? 'Daxko auth timed out' : 'Daxko login failed';
      return logRunSummary({ status: 'error', message: loginErr.message, screenshotPath, phase: 'auth', reason: _reason, category: 'auth', label: _label });
    }

    // Auth phase complete — release the lock immediately so user-initiated
    // actions (e.g. "Verify connection") are never blocked by class discovery.
    if (_authLockAcquired) {
      releaseLock();
      _authLockAcquired = false;
    }

    browser = _session.browser;
    const page = _session.page;
    // Wrap session snap so screenshotPath in this closure stays current.
    // Task #96 — same 400 ms pre-snap settle wait as captureFailure() so
    // Tools-visible preflight/full/waitlist screenshots reflect FW's final
    // render (e.g. Register→Waitlist button flip on full-class modals)
    // rather than a transient pre-settle frame. snap() is observation-only;
    // the booking decision is unaffected by the small delay.
    const snap = async (label = '') => {
      await page.waitForTimeout(400).catch(() => {});
      const p = await _session.snap(label);
      if (p) screenshotPath = p;
    };
    // Structured failure capture — saves to data/screenshots/{date}/{jobId}_{phase}_{reason}_{ts}.png
    // and updates screenshotPath so logRunSummary / recordFailure pick it up.
    const captureFailure = async (phase, reason) => {
      // Task #96 — small settle wait so the screenshot reflects FW's final
      // render. FamilyWorks (Bubble.io) can flip a full-class modal button
      // from "Register" → "Waitlist" up to ~400 ms after the modal opens, and
      // schedule re-renders also lag the underlying state by a few hundred
      // milliseconds. Snapping immediately captures a transient pre-settle
      // frame that doesn't match what the bot reasoned about a moment later.
      // 400 ms is well under any retry/timeout budget and only delays the
      // failure path (the booking decision is already made by this point).
      await page.waitForTimeout(400).catch(() => {});
      const p = await captureFailureScreenshot(page, {
        jobId:  job.id || job.jobId || null,
        phase,
        reason,
      });
      if (p) screenshotPath = p;
      return p;
    };
    // Emits a failure/uncertain event and auto-attaches the current screenshotPath.
    // Always call captureFailure() before emitFailure() so the ref is already set.
    const emitFailure = (phase, failureType, message, extra = {}) => {
      const ref = _screenshotRef(screenshotPath);
      emitEvent(_state, phase, failureType, message, ref ? { ...extra, screenshot: ref } : extra);
    };
    // Debug-mode milestone capture — only fires when DEBUG_SCREENSHOTS=true.
    // Uses the same naming scheme as captureFailure (phase + reason become the
    // filename components) so the screenshots appear in the same date directory
    // and are served by the same /api/screenshots/ route.
    // No-op in production (DEFAULT: DEBUG_SCREENSHOTS is false).
    const captureDebug = async (phase, label) => {
      if (!DEBUG_SCREENSHOTS) return null;
      console.log(`[debug-screenshot] Capturing: ${phase}/${label}`);
      const p = await captureFailureScreenshot(page, {
        jobId:  job.id || job.jobId || null,
        phase,
        reason: label,
      });
      if (p) screenshotPath = p;
      return p;
    };

    // Step 2: Go to schedule and filter by the job's instructor
    advance(_state, 'NAVIGATION');
    console.log('Navigating to schedule...');

    // Stage 2: Capture API responses (eventinstance) during schedule page load.
    // The Bubble.io JS makes authenticated API calls as the page renders.
    // We intercept those responses and feed them into the schedule cache so the
    // classifier can determine availability without an extra browser launch.
    const _apiCapture = [];
    const _captureResponse = async (resp) => {
      try {
        if (!resp.url().includes('my.familyworks.app/api/1.1/')) return;
        if (resp.status() >= 400) return;
        const body = await resp.json().catch(() => null);
        const results = body?.response?.results;
        if (!Array.isArray(results) || results.length === 0) return;
        const first = results[0];
        // eventinstance shape: has start_date_date + title_text
        if (first.start_date_date && (first.title_text || first.type_option_event_type)) {
          _apiCapture.push(...results);
        }
      } catch { /* non-blocking — ignore any parse errors */ }
    };
    page.on('response', _captureResponse);

    _tc.page_nav_start = new Date().toISOString();
    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 });
    // Use domcontentloaded (best-effort) instead of networkidle — the Bubble.io
    // SPA keeps background XHR alive for 15-20 extra seconds after the page is
    // usable, so networkidle with its default 30s timeout fires late or not at
    // all under load (e.g. at booking-window open time).  The real readiness
    // gate is the waitForFunction for dropdown options below (line ~877).
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {
      console.log('[schedule] domcontentloaded timeout — proceeding anyway');
    });
    await page.waitForTimeout(1000); // waitForFunction below is the real gate

    // Save captured API entries to cache (best-effort — never throws).
    page.off('response', _captureResponse);
    if (_apiCapture.length > 0) {
      try {
        const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const TZ = 'America/Los_Angeles';
        const entries = _apiCapture
          .filter(r => r.start_date_date && r.title_text)
          .map(r => {
            const d    = new Date(r.start_date_date);
            const cap  = (r.current_capacity__text__text || '').replace(/<[^>]+>/g, '');
            const m    = cap.match(/(\d+)\/(\d+)/);
            const cur  = m ? parseInt(m[1], 10) : (r.current_capacity_number ?? null);
            const tot  = m ? parseInt(m[2], 10) : (r.max_capacity_number ?? null);
            return {
              title:         r.title_text,
              dayOfWeek:     DAY_NAMES[d.getDay()],
              dateISO:       d.toLocaleDateString('en-CA', { timeZone: TZ }),
              timeLocal:     d.toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }),
              instructor:    null,
              location:      null,
              openSpots:     tot != null && cur != null ? tot - cur : null,
              totalCapacity: tot,
              isFull:        tot != null && cur != null && cur >= tot,
              isWaitlist:    (r.waitlist_number_number ?? 0) > 0,
              isCancelled:   r.cancelled__boolean === true,
              isOpen:        r.isopen_boolean === true,
              capturedAt:    new Date().toISOString(),
            };
          });
        if (entries.length > 0) {
          mergeAndSaveEntries(entries);
          console.log(`[schedule-cache] Captured ${entries.length} class entries from API responses.`);
        }
      } catch (cacheErr) {
        console.warn('[schedule-cache] Failed to save captured entries:', cacheErr.message);
      }
    }

    console.log('Schedule loaded. URL:', page.url());

    // Auth check: if the schedule page is asking us to log in, session didn't carry over
    const loginPrompt = await page.locator('text=/login to register/i').count();
    if (loginPrompt > 0) {
      console.log('Schedule page shows "Login to Register" — session not established.');
      await captureFailure('auth', 'session_expired');
      emitFailure('AUTH', 'AUTH_SESSION_EXPIRED',
        'Session not established — schedule page requires login', {
        evidence: {
          provider: 'FamilyWorks',
          detail:   'Schedule embed showed login prompt after Daxko auth',
          url:      page.url(),
        }
      });
      _saveFwStatus({ ready: false, status: 'FAMILYWORKS_SESSION_MISSING', checkedAt: new Date().toISOString(), source: _runSource, detail: 'Schedule page requires login — FamilyWorks session missing' });
      return logRunSummary({ status: 'error', message: 'Session not established — schedule page requires login', screenshotPath, phase: 'auth', reason: 'session_expired', category: 'auth', label: 'Session expired on schedule page', url: page.url() });
    }
    console.log('Auth valid on schedule page — continuing.');
    emitEvent(_state, 'AUTH', null, 'Auth valid on schedule page');
    _state.bundle.session = 'SESSION_READY';
    await captureDebug('auth', 'session_confirmed');

    // Wait for any dropdown to have options loaded (Bubble.io loads them async)
    await page.waitForFunction(() => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (sel.options.length > 1) return true;
      }
      return false;
    }, { timeout: 15000 }).catch(() => console.log('⚠️ Dropdown options slow to load, proceeding anyway'));
    _tc.page_nav_done = new Date().toISOString();

    // ── Branches → Eugene Y BEFORE readiness probe (April 2026 site change) ──
    // YMCA added a "Branches" dropdown that defaults to blank.  Until a branch
    // is picked the schedule grid renders zero cards, which would cause the
    // readiness probe below to time out and set _scheduleNotLoaded — locking
    // out every subsequent filter (including Branches itself, chicken-and-egg).
    // Strategy: page.selectOption() + synthetic input/change event dispatch
    // (Branches uses a real native <select>, not a Bubble overlay, so a
    // pill-click fallback is structurally wrong and was removed).
    // We also re-apply this after the reload-retry inside waitForScheduleReady,
    // because page.reload() resets the dropdown back to blank.
    async function selectBranchEugeneY() {
      try {
        const branchesIdxPre = await page.evaluate(() => {
          const sels = Array.from(document.querySelectorAll('select'));
          for (let i = 0; i < sels.length; i++) {
            const first = (sels[i].options[0] && sels[i].options[0].text || '').trim().toLowerCase();
            if (first === 'branches') return i;
          }
          return -1;
        });
        if (branchesIdxPre < 0) {
          console.log('[branches] No Branches dropdown found — skipping (older site layout?).');
          return false;
        }
        console.log(`[branches] Branches dropdown at index ${branchesIdxPre} — selecting "Eugene Y"…`);
        // Strategy 1: native selectOption with synthetic events to nudge Bubble.io.
        await page.locator('select').nth(branchesIdxPre)
          .selectOption('Eugene Y', { timeout: 3000, force: true })
          .catch(e => console.log(`[branches] selectOption threw: ${e.message}`));
        // Bubble.io binds to its own state, not the underlying <select>, so
        // also fire input/change events explicitly in case selectOption was a no-op.
        await page.evaluate((idx) => {
          const sel = document.querySelectorAll('select')[idx];
          if (!sel) return;
          for (const opt of sel.options) {
            if ((opt.text || '').trim() === 'Eugene Y') {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('input',  { bubbles: true }));
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }, branchesIdxPre);
        await page.waitForTimeout(1500);

        // Did the schedule begin rendering?  Check for class-count widget OR
        // a visible class card with a time.
        const stateAfter = await page.evaluate(() => {
          // Pick the MAX visible count across all "X classes this week" matches.
          // The page may have multiple such elements (stale placeholders + the
          // real one); breaking on the first match would lock us into "0".
          let countText = null;
          for (const el of document.querySelectorAll('*')) {
            if (el.children.length !== 0) continue;
            const m = (el.textContent || '').match(/(\d+)\s+class(?:es)?\s+this\s+week/i);
            if (!m) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const n = parseInt(m[1], 10);
            if (countText === null || n > countText) countText = n;
          }
          let cardVisible = false;
          const timeRe = /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i;
          for (const el of document.querySelectorAll('*')) {
            if (el.children.length !== 0) continue;
            if (!timeRe.test((el.textContent || '').trim())) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { cardVisible = true; break; }
          }
          return { countText, cardVisible };
        });
        // Branches uses a native <select> (not a Bubble overlay), so a pill-click
        // fallback won't work — the <option> lives inside the select and is only
        // visible when the user opens it natively.  Report the post-state and
        // let the readiness probe decide whether to bail.
        console.log(`[branches] After native + synthetic events — count=${stateAfter.countText}, cardVisible=${stateAfter.cardVisible}.`);
        return stateAfter.countText !== null && stateAfter.countText > 0;
      } catch (be) {
        console.log(`[branches] selectBranchEugeneY threw: ${be.message}`);
        return false;
      }
    }
    await selectBranchEugeneY();

    // ── Centralized schedule-readiness wait (Task #62) ─────────────────────
    // Replaces the inline 2-second wait that previously lived inside
    // applyFilterBySelectIndex.  Runs ONCE here, just after navigation, with
    // a more generous ~10 s budget and a multi-signal probe (count text /
    // visible class card / spinner gone).  If the wait fails we perform
    // exactly one page.reload() + re-probe before flagging
    // _scheduleNotLoaded — preserving the unfiltered-fallback skip from
    // Task #59 so we never click on rows when the schedule never rendered.
    async function waitForScheduleReady() {
      const start    = Date.now();
      const deadline = start + 10000;
      let lastProbe  = null;
      let sawSpinner = false;     // gate for spinner_gone signal
      let pollCount  = 0;
      let lastLogAt  = start;
      while (Date.now() < deadline) {
        pollCount++;
        lastProbe = await page.evaluate(() => {
          // Pick the MAX visible count across all "X classes this week" matches.
          // The page can hold multiple such elements (e.g. a stale "0 classes
          // this week" placeholder for an unselected branch in addition to the
          // real "65 classes this week" total). Breaking on the first match
          // would lock the probe into 0 even after the real count renders.
          let count = null;
          for (const el of document.querySelectorAll('*')) {
            if (el.children.length !== 0) continue;
            const t = el.textContent || '';
            const m = t.match(/(\d+)\s+class(?:es)?\s+this\s+week/i);
            if (!m) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const n = parseInt(m[1], 10);
            if (count === null || n > count) count = n;
          }
          let cardVisible = false;
          const timeRe = /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i;
          for (const el of document.querySelectorAll('*')) {
            if (el.children.length !== 0) continue;
            const t = (el.textContent || '').trim();
            if (!timeRe.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { cardVisible = true; break; }
          }
          let spinnerVisible = false;
          for (const el of document.querySelectorAll('[class*="loading" i],[class*="spinner" i],[class*="loader" i]')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { spinnerVisible = true; break; }
          }
          return { count, cardVisible, spinnerVisible };
        }).catch(() => ({ count: null, cardVisible: false, spinnerVisible: false }));
        if (lastProbe.spinnerVisible) sawSpinner = true;
        // ANY rendered count widget — even "0 classes this week" — means the
        // Bubble app has finished its initial paint. The "Today" tab may be a
        // genuinely-empty day (e.g. a holiday closure or just no offerings);
        // we'll still navigate to the actual target-date tab afterwards,
        // where classes do exist.
        if (lastProbe.count !== null) {
          return { ready: true, signal: `count_text=${lastProbe.count}`, elapsedMs: Date.now() - start, polls: pollCount };
        }
        if (lastProbe.cardVisible) {
          return { ready: true, signal: 'card_visible', elapsedMs: Date.now() - start, polls: pollCount };
        }
        // spinner_gone: only safe to treat as ready when we previously observed
        // a spinner AND the count widget has rendered (count !== null), since
        // a count of 0 with no spinner could otherwise be a genuinely empty
        // schedule that we'd mis-classify as ready. Combined gating keeps the
        // false-positive surface narrow.
        if (sawSpinner && !lastProbe.spinnerVisible && lastProbe.count !== null) {
          return { ready: true, signal: `spinner_gone(count=${lastProbe.count})`, elapsedMs: Date.now() - start, polls: pollCount };
        }
        // Periodic progress log (~1 Hz) so slow renders are visible in logs.
        if (Date.now() - lastLogAt >= 1000) {
          console.log(`[schedule-ready]   …probing (${Date.now() - start}ms elapsed, polls=${pollCount}, count=${lastProbe.count}, cardVisible=${lastProbe.cardVisible}, spinnerVisible=${lastProbe.spinnerVisible}, sawSpinner=${sawSpinner})`);
          lastLogAt = Date.now();
        }
        await page.waitForTimeout(200);
      }
      return { ready: false, signal: null, elapsedMs: Date.now() - start, polls: pollCount, lastProbe, sawSpinner };
    }

    console.log(`[schedule-ready] (initial) probing schedule readiness up to 10s…`);
    let scheduleReadiness = await waitForScheduleReady();
    if (scheduleReadiness.ready) {
      console.log(`[schedule-ready] (initial) ready — signal=${scheduleReadiness.signal} after ${scheduleReadiness.elapsedMs}ms (polls=${scheduleReadiness.polls}).`);
    } else {
      console.log(`[schedule-ready] (initial) NOT ready after ${scheduleReadiness.elapsedMs}ms (polls=${scheduleReadiness.polls}, sawSpinner=${scheduleReadiness.sawSpinner}, lastProbe=${JSON.stringify(scheduleReadiness.lastProbe)}) — performing ONE page.reload() retry before bailing.`);
      try {
        await page.reload({ timeout: 60000, waitUntil: 'domcontentloaded' });
      } catch (rErr) {
        console.log(`[schedule-ready] page.reload() threw: ${rErr.message}`);
      }
      await page.waitForTimeout(1000);
      // Re-wait for dropdowns to repopulate after reload.
      await page.waitForFunction(() => {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) { if (sel.options.length > 1) return true; }
        return false;
      }, { timeout: 15000 }).catch(() => console.log('[schedule-ready] (after-reload) dropdown options slow to load, proceeding anyway'));
      // Re-apply Branches → Eugene Y because page.reload() reset it back to blank.
      await selectBranchEugeneY();
      console.log(`[schedule-ready] (after-reload) re-probing schedule readiness up to 10s…`);
      scheduleReadiness = await waitForScheduleReady();
      if (scheduleReadiness.ready) {
        console.log(`[schedule-ready] (after-reload) ready — signal=${scheduleReadiness.signal} after ${scheduleReadiness.elapsedMs}ms (polls=${scheduleReadiness.polls}).`);
      } else {
        console.log(`[schedule-ready] (after-reload) STILL not ready after ${scheduleReadiness.elapsedMs}ms (polls=${scheduleReadiness.polls}, sawSpinner=${scheduleReadiness.sawSpinner}, lastProbe=${JSON.stringify(scheduleReadiness.lastProbe)}) — flagging _scheduleNotLoaded; caller will bail with schedule_not_loaded after the unfiltered-fallback skip.`);
        // DIAGNOSTIC: dump everything matching "X classes" plus viewport size and
        // a body-text excerpt so we can tell whether the schedule simply hasn't
        // rendered (headless bot sees an empty page) vs the regex is missing it
        // (page rendered "65 classes this week" but our matcher couldn't find it).
        try {
          const diag = await page.evaluate(() => {
            const matches = [];
            const re = /(\d+)\s+class(?:es)?\s+this\s+week/i;
            for (const el of document.querySelectorAll('*')) {
              const t = (el.textContent || '');
              if (!re.test(t) || t.length > 200) continue;
              const r = el.getBoundingClientRect();
              matches.push({
                tag: el.tagName,
                children: el.children.length,
                text: t.trim().slice(0, 100),
                visible: r.width > 0 && r.height > 0,
                rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
              });
              if (matches.length >= 8) break;
            }
            const bodyTxt = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
            return {
              viewport: { w: window.innerWidth, h: window.innerHeight },
              url: location.href,
              title: document.title,
              selectCount: document.querySelectorAll('select').length,
              matches,
              bodyTextLen: bodyTxt.length,
              bodyTextHead: bodyTxt.slice(0, 600),
            };
          });
          console.log('[schedule-ready][diag]', JSON.stringify(diag, null, 2));
          // Save a screenshot of what the headless bot actually sees so we can
          // visually diff it against the anonymous public view.
          try {
            const path = `/tmp/schedule-headless-${Date.now()}.png`;
            await page.screenshot({ path, fullPage: true });
            console.log(`[schedule-ready][diag] screenshot saved → ${path}`);
          } catch (se) {
            console.log(`[schedule-ready][diag] screenshot failed: ${se.message}`);
          }
        } catch (de) {
          console.log(`[schedule-ready][diag] threw: ${de.message}`);
        }
        _scheduleNotLoaded = true;
      }
    }

    // Log all selects and their options so we can see what filters are available.
    const allSelectInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map((sel, i) => ({
        index: i,
        options: Array.from(sel.options).map(o => o.text),
      }));
    });
    console.log('Available select dropdowns:', JSON.stringify(allSelectInfo));

    // ── Dropdown index lookup by label (April 2026 YMCA site change) ──────────
    // YMCA added a new "Branches" dropdown at index 1, shifting every other
    // filter's position (Location 1→2, Instructor 2→3, Event Name 3→4).  To
    // survive future column reorderings we now look up dropdowns by their
    // first-option label instead of by hardcoded index.  The first <option>
    // text is always the dropdown's placeholder/label (e.g. "Category",
    // "Branches", "Location", "Instructor", "Event Name").
    function findSelectIndexByLabel(label) {
      const lc = label.trim().toLowerCase();
      const hit = allSelectInfo.find(s => (s.options[0] || '').trim().toLowerCase() === lc);
      return hit ? hit.index : -1;
    }
    const CATEGORY_IDX   = findSelectIndexByLabel('Category');
    const BRANCHES_IDX   = findSelectIndexByLabel('Branches');
    const INSTRUCTOR_IDX = findSelectIndexByLabel('Instructor');
    console.log(`  Resolved dropdown indexes — Category=${CATEGORY_IDX}, Branches=${BRANCHES_IDX}, Instructor=${INSTRUCTOR_IDX}`);

    // Bubble.io ignores programmatic changes to hidden <select> elements.
    // Bubble.io dropdown strategy:
    //   1. The real <select> is hidden (display:none). Its PARENT is the visible pill.
    //   2. We click the parent wrapper to open the custom dropdown overlay.
    //   3. After the overlay appears, we find the first VISIBLE element whose text
    //      exactly matches the target value and click it.
    //   4. We do this for every filter regardless of the pill's current label, so a
    //      stale session filter that didn't trigger a re-render gets refreshed too.
    // Bubble.io dropdowns require a full pointer-event chain (pointerdown → mousedown
    // → mouseup → click).  JS element.click() only fires the click event and misses
    // pointerdown/mousedown, so Bubble's overlay never opens.
    // Fix: get the wrapper's Bubble.io class suffix (unique per element), then use
    // Playwright's native locator.click() which replays the full event sequence.
    async function applyFilterBySelectIndex(selectIndex, targetValue, filterLabel) {
      // Schedule-readiness wait now lives centrally (Task #62) — it runs
      // ONCE just after navigation with a 10s budget + reload retry, and
      // sets `_scheduleNotLoaded = true` if the schedule never rendered.
      // If that flag is set, short-circuit immediately so the caller's bail
      // path fires (skipping the noisy unfiltered fallback from Task #59).
      if (_scheduleNotLoaded) {
        console.log(`  Filter #${selectIndex} (${filterLabel}): _scheduleNotLoaded is set — skipping filter application.`);
        return false;
      }

      // Step 1: Walk up from the hidden <select> to find the INDIVIDUAL PILL wrapper.
      // Key: the pill contains exactly 1 <select>; the filter bar row contains all 4.
      // We use this to skip past the row and find the pill precisely.
      const pillInfo = await page.evaluate((idx) => {
        const sels = document.querySelectorAll('select');
        if (idx >= sels.length) return null;
        let el = sels[idx].parentElement;
        while (el && el !== document.body) {
          const r = el.getBoundingClientRect();
          const selectCount = el.querySelectorAll('select').length;
          // Valid pill: visible dimensions AND contains exactly this one select
          if (r.width > 20 && r.height > 10 && selectCount === 1) {
            const m = el.className.match(/\bcpi\w+\b/);
            return { cls: m ? m[0] : null, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
          }
          el = el.parentElement;
        }
        return null;
      }, selectIndex);

      if (!pillInfo || !pillInfo.cls) {
        console.log(`⚠️ Could not find individual pill for filter #${selectIndex} (${filterLabel}). pillInfo:`, pillInfo);
        return false;
      }
      console.log(`  Filter #${selectIndex} (${filterLabel}) pill: .${pillInfo.cls} ${pillInfo.w}×${pillInfo.h} @ (${pillInfo.x},${pillInfo.y}) — trying native select first...`);

      // Strategy A: Use Playwright's page.selectOption() on the native hidden <select>.
      // Playwright fires the full input/change/blur event chain; Bubble.io may honour it.
      // Return early if the class count changes — means the filter actually applied.
      try {
        const initialCount = await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            const m = el.textContent.match(/(\d+)\s+class(?:es)?\s+this\s+week/i);
            if (m && el.children.length === 0) return parseInt(m[1], 10);
          }
          return null;
        });
        await page.locator('select').nth(selectIndex).selectOption(targetValue, { timeout: 3000, force: true });
        // Signal-driven settle: resolve as soon as the class count changes, which is
        // the most reliable indicator that Bubble.io has applied the filter and
        // re-rendered the schedule.  Capped at 1500 ms (vs the old flat 1000 ms)
        // so a slow re-render still gets enough time; a fast one exits early.
        // If initialCount was not detected, fall back to a short static pause.
        if (initialCount !== null) {
          await page.waitForFunction((initial) => {
            for (const el of document.querySelectorAll('*')) {
              const m = el.textContent.match(/(\d+)\s+class(?:es)?\s+this\s+week/i);
              if (m && el.children.length === 0) return parseInt(m[1], 10) !== initial;
            }
            return false; // count element not yet updated — keep polling
          }, initialCount, { timeout: 1500 }).catch(() => {});
        } else {
          await page.waitForTimeout(600);
        }
        const newCount = await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            const m = el.textContent.match(/(\d+)\s+class(?:es)?\s+this\s+week/i);
            if (m && el.children.length === 0) return parseInt(m[1], 10);
          }
          return null;
        });
        // PRIMARY success signal: the <select>'s selectedOption text now matches
        // what we asked for.  Class-count delta is unreliable on empty days
        // (count stays 0→0 even when filters apply, so the delta tells us nothing).
        const selectedText = await page.evaluate((idx) => {
          const sel = document.querySelectorAll('select')[idx];
          if (!sel) return null;
          const opt = sel.options[sel.selectedIndex];
          return opt ? (opt.text || '').trim() : null;
        }, selectIndex);
        console.log(`  Native selectOption for "${targetValue}": class count ${initialCount} → ${newCount}, selectedOption="${selectedText}"`);
        const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        const targetTrim = (targetValue || '').trim();
        if (selectedText && norm(selectedText) === norm(targetTrim)) {
          console.log(`✅ Filter #${selectIndex} (${filterLabel}) applied via native select — selectedOption matches target.`);
          return true;
        }
        if (newCount !== null && newCount !== initialCount) {
          console.log(`✅ Filter #${selectIndex} (${filterLabel}) applied via native select — count changed!`);
          return true;
        }
        // Native selectOption did not change the class count → filter had no effect.
      // Do NOT fall back to pill click: in headless mode, opening the Bubble.io custom
      // dropdown without completing a selection leaves it in a partially-applied state
      // that corrupts subsequent filter attempts (observed: count dropped from 79→14
      // when pill was clicked but option was never selected).
      console.log(`  Native selectOption did not change class count and selectedOption (${selectedText}) ≠ target (${targetTrim}) — skipping pill click to avoid state corruption.`);
      return false;
    } catch (nse) {
      console.log(`  Native selectOption threw: ${nse.message} — skipping pill click to avoid state corruption.`);
      return false;
    }
    // (pill-click approach removed: Bubble.io custom dropdowns never open in headless mode
    //  and partial clicks corrupt the filter state)
  }

    // Filter strategy: Branches (Eugene Y) FIRST, then Category + Instructor via native
    // selectOption.  The Branches dropdown was added by YMCA in April 2026 and defaults
    // to blank — without selecting "Eugene Y" the schedule grid renders zero cards and
    // our readiness probe times out (root cause of the schedule_not_loaded bail loop).
    // Event Name filter is intentionally skipped: its native selectOption fails
    // ("did not find some options") and the pill-click fallback corrupts Bubble.io state
    // by partially opening the dropdown (observed: count went 79→14 from an aborted click).
    _tc.filter_apply_start = new Date().toISOString();

    // (Branches selection happens earlier, before the readiness probe — see
    // the [branches] block above.  Re-applying here would be a no-op and could
    // burn time on a redundant Bubble.io re-render.)
    let categoryApplied = CATEGORY_IDX >= 0
      ? await applyFilterBySelectIndex(CATEGORY_IDX, 'Yoga/Pilates', 'Category')
      : false;

    // Resolve instructor filter value: the DB may store just a first name (e.g. "Gretl")
    // or a full name (e.g. "Stephanie Sanders").  Find the best match from the dropdown
    // so selectOption() can do an exact-text match against the option element.
    let instructorForFilter = null;
    if (instructor && INSTRUCTOR_IDX >= 0) {
      const instrDropdown = allSelectInfo.find(s => s.index === INSTRUCTOR_IDX);
      if (instrDropdown) {
        const instrLower = instructor.trim().toLowerCase();
        // Prefer exact match first, then starts-with, then contains
        const exactMatch    = instrDropdown.options.find(o => o.trim().toLowerCase() === instrLower);
        const startsMatch   = instrDropdown.options.find(o => o.trim().toLowerCase().startsWith(instrLower));
        const containsMatch = instrDropdown.options.find(o => o.trim().toLowerCase().includes(instrLower));
        instructorForFilter = exactMatch || startsMatch || containsMatch || null;
        if (instructorForFilter) {
          console.log(`  Instructor lookup: "${instructor}" → "${instructorForFilter}"`);
        } else {
          console.log(`  ⚠️ Instructor lookup: no dropdown option matched "${instructor}" — will scan without instructor filter.`);
        }
      }
    }
    let instructorApplied = (instructorForFilter && INSTRUCTOR_IDX >= 0)
      ? await applyFilterBySelectIndex(INSTRUCTOR_IDX, instructorForFilter, 'Instructor')
      : false;

    _tc.filter_apply_done = new Date().toISOString();
    if (!categoryApplied)   console.log('⚠️ Category filter not applied — will scan all categories.');
    if (!instructorApplied) console.log('⚠️ Instructor filter not applied — will scan all instructors.');

    // ── POINT 2: navigate — filter application failure ────────────────────────
    // Distinguish two failure modes:
    //   (a) schedule_not_loaded — schedule panel was empty before & after the
    //       readiness wait. The unfiltered scan would race a card-render and
    //       could click an unrelated promo (Apr 16 Rise & Align Yoga incident).
    //       Bail with a distinct reason so the retry loop tries again with a
    //       fresh page state instead of falling into the noisy scan.
    //   (b) filter_apply_failed — schedule had cards, but native selectOption
    //       didn't change the count. Existing behaviour: continue with an
    //       unfiltered scan.
    if (!categoryApplied && !instructorApplied) {
      // ── Self-Healing / Safe Recovery Pass — Stage 3: page-reset heal ────────
      // Both filters reported no effect. Before falling through to the existing
      // truthful failure path (filter_apply_failed → filtersFailed=true → no
      // unfiltered booking), attempt ONE bounded page-reset heal:
      //   1. page.reload()  — clear any partially-applied Bubble.io state
      //   2. waitForScheduleReady() — bounded readiness probe (already exists)
      //   3. re-select Branches → "Eugene Y" (reload reverts it to blank)
      //   4. re-apply Category and Instructor filters via the same closure
      // If at least one filter applies after heal, we proceed normally with the
      // restored state. If both still fail, we fall through to the original
      // failure handling unchanged — no truthful classification is lost.
      // Bounded: at most ONE attempt per run (_pageHealAttempts counter).
      // Safe:    no Register click in this block, no identity check weakened.
      if (_pageHealAttempts === 0 && !_scheduleNotLoaded) {
        _pageHealAttempts++;
        console.log('🩹 [page-heal/stage-3] Both filters failed — attempting one bounded page-reset heal (reload + re-apply Eugene Y + re-apply filters)…');
        const healStartedAt = Date.now();
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          await waitForScheduleReady();
          if (BRANCHES_IDX >= 0) {
            await page.locator('select')
              .nth(BRANCHES_IDX)
              .selectOption('Eugene Y', { timeout: 3000, force: true })
              .catch(e => console.log(`🩹 [page-heal] branches re-select threw: ${e.message}`));
            await page.waitForTimeout(400);
          }
          const healCategoryApplied = CATEGORY_IDX >= 0
            ? await applyFilterBySelectIndex(CATEGORY_IDX, 'Yoga/Pilates', 'Category')
            : false;
          const healInstructorApplied = (instructorForFilter && INSTRUCTOR_IDX >= 0)
            ? await applyFilterBySelectIndex(INSTRUCTOR_IDX, instructorForFilter, 'Instructor')
            : false;
          categoryApplied   = healCategoryApplied;
          instructorApplied = healInstructorApplied;
          const elapsedMs = Date.now() - healStartedAt;
          if (categoryApplied || instructorApplied) {
            console.log(`🩹 [page-heal/stage-3] ✅ Trust restored after ${elapsedMs} ms — categoryApplied=${categoryApplied}, instructorApplied=${instructorApplied}.`);
          } else {
            console.log(`🩹 [page-heal/stage-3] ❌ Heal did not restore filters after ${elapsedMs} ms — falling through to truthful failure classification.`);
          }
        } catch (he) {
          console.log(`🩹 [page-heal/stage-3] ❌ Heal threw: ${he.message} — falling through to truthful failure classification.`);
        }
      }
      // ────────────────────────────────────────────────────────────────────────
    }

    if (!categoryApplied && !instructorApplied) {
      if (_scheduleNotLoaded) {
        console.log('⚠️ Schedule not loaded after centralized 10s wait + one reload retry (Task #62) — bailing with schedule_not_loaded (skipping unfiltered fallback to avoid wrong-card click).');
        await captureFailure('navigate', 'schedule_not_loaded');
        recordFailure({
          jobId:    job.id || job.jobId || null,
          phase:    'navigate', reason: 'schedule_not_loaded',
          category: 'navigate', label: 'Schedule panel had not rendered after readiness wait + reload retry',
          message:  'Schedule panel was empty after centralized readiness wait (10s) and one in-run page.reload() retry — filters could not be evaluated; will retry with a fresh page state.',
          classTitle,
          screenshot: _screenshotRef(screenshotPath),
          url:      page.url(),
          context:  { categoryApplied, instructorApplied, scheduleNotLoaded: true },
        });
        return logRunSummary({
          status: 'error',
          message: 'Schedule had not rendered when filters were applied — will retry on the next attempt.',
          screenshotPath,
          phase: 'navigate', reason: 'schedule_not_loaded',
          category: 'navigate', label: 'Schedule not loaded',
          url: page.url(),
        });
      }
      filtersFailed = true;  // carried through to logRunSummary for re-classification
      console.log('⚠️ Both filters failed — schedule unfiltered; scan may be noisy.');
      await captureFailure('navigate', 'filter_apply_failed');
      recordFailure({
        jobId:    job.id || job.jobId || null,
        phase:    'navigate', reason: 'filter_apply_failed',
        category: 'navigate', label: 'Both schedule filters failed to apply',
        message:  'Category and Instructor filters both had no effect — schedule is unfiltered',
        classTitle,
        screenshot: _screenshotRef(screenshotPath),
        url:      page.url(),
        context:  { categoryApplied, instructorApplied },
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    await page.waitForTimeout(600); // POINT 3 check below validates rendered content

    // ── POINT 3: navigate — schedule not rendered ─────────────────────────────
    // A rendered schedule should have at least one element with a time string and
    // card-sized bounding box. Zero results usually means Bubble.io stalled.
    const scheduleHasRows = await page.evaluate(() => {
      const timeRe = /\d{1,2}:\d{2}/;
      return [...document.querySelectorAll('*')].some(el => {
        if (el.children.length === 0) return false;
        if (!timeRe.test(el.textContent)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 100 && r.height >= 30;
      });
    }).catch(() => true); // default true — don't false-positive on eval error

    if (!scheduleHasRows) {
      console.log('⚠️ Schedule appears empty (0 time-bearing card-sized rows) — waiting 1000 ms then re-checking...');
      await page.waitForTimeout(1000);
      const scheduleHasRowsRetry = await page.evaluate(() => {
        const timeRe = /\d{1,2}:\d{2}/;
        return [...document.querySelectorAll('*')].some(el => {
          if (el.children.length === 0) return false;
          if (!timeRe.test(el.textContent)) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 100 && r.height >= 30;
        });
      }).catch(() => true);

      if (!scheduleHasRowsRetry) {
        // Task #96 — distinguish a true Bubble.io stall from a legitimately
        // empty day. FW renders "No Classes on <date>" with a "Try <day>" pill
        // when the currently-selected day tab has no classes scheduled. That's
        // the schedule honestly telling us the day is empty; clicking the
        // target day-tab next will re-render the card list. Recording a
        // failure in that case is misleading and noisy in Tools.
        const emptyByScheduleHint = await page.evaluate(() => {
          const txt = (document.body?.innerText || '').toLowerCase();
          // FW empty-day strings: "No Classes on <date>" + adjacent "Try <day>" CTA.
          // Require BOTH signals to avoid suppressing real Bubble.io stalls when
          // the page incidentally contains one of these phrases in tooltips/help.
          return /\bno classes\b/.test(txt) && /\btry\s+(sun|mon|tue|wed|thu|fri|sat)\b/.test(txt);
        }).catch(() => false);
        if (emptyByScheduleHint) {
          console.log('ℹ️ Schedule shows "No Classes" empty-state for current tab — skipping render failure (will click target day tab next).');
        } else {
          console.log('⚠️ Schedule still empty after 1000 ms retry — recording render failure and continuing.');
          await captureFailure('navigate', 'schedule_not_rendered');
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'navigate', reason: 'schedule_not_rendered',
            category: 'navigate', label: 'Schedule rendered 0 rows after filter',
            message:  'No time-containing card-sized elements visible after filter application (confirmed after 1000 ms retry)',
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  { categoryApplied, instructorApplied },
          });
          // Non-terminal — continue; tab click may trigger re-render.
        }
      } else {
        console.log('✅ Schedule rows appeared after 1000 ms retry — continuing normally.');
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    advance(_state, 'DISCOVERY');
    _tc.class_discovery_start = new Date().toISOString();
    await captureDebug('navigate', 'schedule_ready');
    console.log(`Looking for: "${classTitle}" on ${dayOfWeek || 'any day'} at "${classTime || 'any time'}" (normalized: "${classTimeNorm || 'n/a'}")`);

    // ---------------------------------------------------------------------------
    // Step 3: Find the target class card.
    //
    // Strategy:
    //  A) Collect ALL visible card-level DOM nodes (min 3, max 300 descendants,
    //     min 100×30 px bounding box).
    //  B) Log every candidate row's text so we can see what's in the DOM.
    //  C) Score each row:
    //       title match "Core Pilates"  → +5  (case-insensitive substring)
    //       time  match classTimeNorm    → +5  (e.g. "7:45 a" for AM, "4:20 p" for PM)
    //       instr match "Stephanie"     → +3  (first name only)
    //  D) Pick the highest-scoring, most-specific (fewest descendants) element
    //     with score ≥ CONFIDENCE_THRESHOLD.  If the best fails post-click
    //     verification the second-best is tried once.
    //  E) If not found immediately, slowly scroll the schedule list (80 px steps)
    //     and retry at each step.
    //  F) Scroll the winning element into view, then find and click its visible
    //     interactive child: role=button, tabindex=0, <a>, <button>, or the
    //     element itself if it is one of those — never an invisible wrapper div.
    // ---------------------------------------------------------------------------

    // Minimum score to consider a row a class candidate.
    // title+time=10 (7:45 AM class), title+instructor=8 (same-instructor class).
    // Setting 8 allows title+instructor rows through; the post-click modal
    // verification is the real safety gate that rejects wrong-time matches.
    const CONFIDENCE_THRESHOLD = 8;

    // Side-channel vars (_lastBestScore, _lastBestText, _lastSecondCard,
    // _lastSecondScore, _lastSecondText, _lastModalPreview) are declared
    // before the try block so logRunSummary() can access them from both
    // the try body and the catch handler.  They are updated by findTargetCard()
    // and attemptClickAndVerify() as the run progresses.

    async function findTargetCard() {
      // Clear any previous markers (best and second-best)
      await page.evaluate(() => {
        document.querySelectorAll('[data-target-class]')
          .forEach(el => el.removeAttribute('data-target-class'));
        document.querySelectorAll('[data-target-class-second]')
          .forEach(el => el.removeAttribute('data-target-class-second'));
      });

      const result = await page.evaluate(({ classTitleLower, instrFirst, confidenceThreshold, classTimeNorm }) => {
        const SKIP_TAGS = new Set(['OPTION','SELECT','SCRIPT','STYLE','HEAD','HTML','BODY','NOSCRIPT','SVG','PATH']);

        // Normalize: collapse all whitespace variants (including Bubble.io's \u00A0)
        function norm(txt) {
          return (txt || '').replace(/[\s\u00A0\u2009\u202f]+/g, ' ').trim();
        }

        // Matching rules:
        //   - time: built dynamically from classTimeNorm passed in from the outer scope.
        //     "7:45 a"  → /7:45\s*a/i   (AM class)
        //     "4:20 p"  → /4:20\s*p/i   (PM class)
        //     The AM/PM letter after the digits is the sole discriminator; no \b anchor
        //     is used because adjacent word chars (e.g. "Eugene Y7:45 a") prevent \b
        //     from firing before the digit.
        //   - title: "Core Pilates" (case-insensitive, any whitespace)
        //   - instr: first name only ("gretl" matches "Gretl G.", "stephanie" matches "Stephanie S.")
        let timeAmRe;
        if (classTimeNorm) {
          const _tm = classTimeNorm.match(/^(\d+:\d+)\s*([ap])/i);
          timeAmRe = _tm ? new RegExp(_tm[1] + '\\s*' + _tm[2], 'i') : /(?!)/;
        } else {
          timeAmRe = /(?!)/; // no time specified — never score on time alone
        }
        const titleParts = classTitleLower.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const titleRe  = new RegExp(titleParts.join('[\\s\\u00A0]+'), 'i');
        const instrRe  = new RegExp(instrFirst, 'i');

        const allRows  = [];   // every node with ≥1 signal
        const allTexts = [];   // ALL candidate texts for diagnostic logging

        for (const el of document.querySelectorAll('*')) {
          if (SKIP_TAGS.has(el.tagName)) continue;

          // ── Fast pre-filter: check text signals BEFORE the expensive desc count ──
          // el.querySelectorAll('*').length is O(N) per element, making the original
          // loop O(N²) overall.  Running it on every DOM node is the main bottleneck
          // in discovery.  By checking textContent + regexes first we only run the
          // expensive count on the ~50-100 elements that contain a relevant signal,
          // instead of the full 2000+ node DOM.  The result set is identical.
          const raw  = el.textContent || '';
          const txt  = norm(raw);
          if (!txt) continue;

          const hasTime  = timeAmRe.test(txt);
          const hasTitle = titleRe.test(txt);
          const hasInstr = instrRe.test(txt);
          if (!hasTitle && !hasTime && !hasInstr) continue; // no signal — skip early

          // ── Desc count (now runs only for signal-bearing elements) ──────────────
          const desc = el.querySelectorAll('*').length;
          // 100-desc cap: excludes page wrappers, filter dropdowns (~200+ desc),
          // and repeating-group containers, while keeping individual class cards (~20-50 desc).
          if (desc > 100) continue;
          if (desc < 2)   continue;   // skip bare text wrappers / leaf nodes

          // ── Layout check (runs only for signal-bearing, card-sized candidates) ──
          // Skip truly hidden elements (display:none / collapsed to 0×0).
          // Bubble.io's virtual repeating-group recycles DOM nodes: when you switch
          // date tabs, old entries get hidden (width=0, height=0) but keep their
          // previous text content.  Scoring these stale nodes leads to clicking
          // invisible elements and crashing the booking attempt.
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const looks_card = r.width >= 100 && r.height >= 30;
          // All elements reaching here have ≥1 signal; no redundant signal guard needed.
          if (looks_card) {
            allTexts.push({ desc, txt: txt.slice(0, 150), hasTime, hasTitle, hasInstr });
          }

          let score = 0;
          const reasons = [];
          if (hasTitle) { score += 5; reasons.push('title+5'); }
          if (hasTime)  { score += 5; reasons.push('time+5');  }
          if (hasInstr) { score += 3; reasons.push('instr+3'); }

          // Require score ≥ confidenceThreshold (8).
          // - title + time + instr = 13 ✓ (best — 7:45 AM class with all three signals)
          // - title + time         = 10 ✓ (strong — correct class name + correct time)
          // - title + instr        =  8 ✓ (passes threshold; verified by modal check)
          // - time  + instr        =  8 ✓ (passes threshold; verified by modal check)
          // - title alone          =  5 ✗ (matches filter dropdown option labels)
          // - time alone           =  5 ✗ (too many classes share a start or end time)
          // - instr alone          =  3 ✗ (far too broad — instructor teaches many classes)
          // Tie-break: highest score wins; within same score, fewest descendants
          // (most specific element) wins — so 7:45 AM (13) always beats 2:45 PM (8).
          if (score < confidenceThreshold) continue;

          // Does this element contain an interactive child (button, [role=button], <a>)?
          // Cards have them; inner text wrappers usually don't.  When two rows tie
          // on score + visibility, prefer the one that the click helper can actually
          // dispatch a real click on — otherwise we fall through to the cursor:pointer
          // hunt which can land on a detail-page link instead of the signup button.
          const hasClickableChild = !!el.querySelector("button, [role='button'], a");

          allRows.push({
            el,
            score,
            reasons,
            desc,
            visible: looks_card,
            hasClickableChild,
            txt: txt.slice(0, 200),
          });
        }

        // Sort: highest score first; prefer visible (looks_card) within same score;
        // then prefer elements with an interactive child (button/[role=button]/a) —
        // this is the real clickable card, not an inner text wrapper;
        // then tie-break on fewest descendants (most specific element);
        // finally, prefer shorter normalized text (tighter element with less
        // surrounding chrome) so two otherwise-identical candidates resolve
        // deterministically instead of falling through to DOM order.
        allRows.sort((a, b) =>
          b.score - a.score ||
          (b.visible ? 1 : 0) - (a.visible ? 1 : 0) ||
          (b.hasClickableChild ? 1 : 0) - (a.hasClickableChild ? 1 : 0) ||
          a.desc - b.desc ||
          a.txt.length - b.txt.length ||
          (a.txt < b.txt ? -1 : a.txt > b.txt ? 1 : 0)
        );

        if (allRows.length === 0) return { matched: null, allResults: [], allTexts };

        // ── Tie-break diagnostic ───────────────────────────────────────────────
        // When the top two candidates are equal on score+visibility, record WHY
        // the winner was picked so we can confirm the Apr 16 fix is firing.
        // (Inner text wrappers tied with their outer card on score+visible; the
        // outer card has a button child, so hasClickableChild flipped the choice.)
        let tieBreakNote = null;
        if (allRows.length >= 2) {
          const w = allRows[0], r = allRows[1];
          if (w.score === r.score && w.visible === r.visible) {
            const reason = w.hasClickableChild !== r.hasClickableChild
              ? `winner has clickable child (${w.hasClickableChild}) vs runner-up (${r.hasClickableChild})`
              : w.desc !== r.desc
                ? `winner has fewer descendants (${w.desc} vs ${r.desc})`
                : w.txt.length !== r.txt.length
                  ? `winner has shorter normalized text (${w.txt.length} vs ${r.txt.length} chars)`
                  : w.txt !== r.txt
                    ? `winner has lexicographically earlier text (deterministic tie-break)`
                    : `truly identical candidates — DOM order picked the winner`;
            tieBreakNote = {
              reason,
              winner:    { desc: w.desc, hasClickable: w.hasClickableChild, txtLen: w.txt.length, txt: w.txt.slice(0, 80) },
              runnerUp:  { desc: r.desc, hasClickable: r.hasClickableChild, txtLen: r.txt.length, txt: r.txt.slice(0, 80) },
            };
          }
        }

        // Mark best match so Playwright can locate it via attribute selector
        allRows[0].el.setAttribute('data-target-class', 'yes');

        // Mark second-best if it exists and score >= threshold - 2 (qualifies as fallback)
        const secondRow = allRows.length > 1 ? allRows[1] : null;
        if (secondRow && secondRow.score >= confidenceThreshold - 2) {
          secondRow.el.setAttribute('data-target-class-second', 'yes');
        }

        // Detect capacity signals in the matched row text so the caller can
        // bail early before clicking rather than timing out on a full card.
        const matchedTxtLower = allRows[0].txt.toLowerCase();
        const rowFull     = /\bfull\b/.test(matchedTxtLower);
        const rowWaitlist = !rowFull && /\bwaitlist\b/.test(matchedTxtLower);

        return {
          matched:      allRows[0].txt,
          score:        allRows[0].score,
          reasons:      allRows[0].reasons,
          desc:         allRows[0].desc,
          visible:      allRows[0].visible,
          tieBreakNote,
          rowFull,
          rowWaitlist,
          secondMatched: secondRow && secondRow.score >= confidenceThreshold - 2 ? secondRow.txt : null,
          secondScore:   secondRow ? secondRow.score : null,
          allResults: allRows.slice(0, 15).map(r => ({
            score: r.score, reasons: r.reasons.join(','), desc: r.desc,
            visible: r.visible, txt: r.txt.slice(0, 120),
          })),
          allTexts,
        };
      }, { classTitleLower, instrFirst: instructorFirstName, confidenceThreshold: CONFIDENCE_THRESHOLD, classTimeNorm });

      // Log ALL visible rows that contained any signal (title, time, or instructor)
      if (result.allTexts && result.allTexts.length > 0) {
        console.log(`  Visible rows with any signal (${result.allTexts.length}):`);
        result.allTexts.forEach((r, i) =>
          console.log(`    row[${i}] desc=${r.desc} T=${r.hasTitle?1:0} t=${r.hasTime?1:0} I=${r.hasInstr?1:0} "${r.txt}"`)
        );
      } else {
        console.log('  No visible rows matched title / time / instructor at all.');
      }

      // Log every scored candidate
      if (result.allResults && result.allResults.length > 0) {
        console.log(`  Scored candidates (${result.allResults.length}):`);
        result.allResults.forEach((r, i) =>
          console.log(`    [${i}] score=${r.score} desc=${r.desc} visible=${r.visible} (${r.reasons}) "${r.txt}"`)
        );
      }

      // Tie-break diagnostic: surfaces WHY allRows[0] beat allRows[1] when they
      // were equal on score+visibility (catches the Apr 16 hasClickableChild flip).
      if (result.tieBreakNote) {
        const tb = result.tieBreakNote;
        console.log(`  [tie-break] ${tb.reason}`);
        console.log(`    winner:    desc=${tb.winner.desc}    hasClickable=${tb.winner.hasClickable} "${tb.winner.txt}"`);
        console.log(`    runner-up: desc=${tb.runnerUp.desc}    hasClickable=${tb.runnerUp.hasClickable} "${tb.runnerUp.txt}"`);
      }

      if (!result.matched) {
        // No candidate passed CONFIDENCE_THRESHOLD — update side-channel and return null
        _lastBestScore   = 0;
        _lastBestText    = '';
        _lastSecondCard  = null;
        _lastSecondScore = 0;
        _lastSecondText  = '';
        _lastAllTexts    = result.allTexts || [];
        _lastBestReasons = [];
        return null;
      }

      // Update side-channel closure vars for the second-best fallback
      _rowCapacityFromSchedule = result.rowFull    ? 'full'     :
                                 result.rowWaitlist ? 'waitlist' : null;
      if (_rowCapacityFromSchedule) {
        console.log(`[row-capacity] Matched row shows "${_rowCapacityFromSchedule}" in schedule text — will bail before click`);
      }
      _lastBestScore   = result.score;
      _lastBestText    = result.matched;
      _lastSecondScore = result.secondScore || 0;
      _lastSecondText  = result.secondMatched || '';
      _lastSecondCard  = result.secondMatched
        ? page.locator('[data-target-class-second="yes"]').first()
        : null;
      _lastBestReasons = result.reasons || [];
      _lastAllTexts    = [];

      // PART 7 — required log lines
      console.log(`Best score: ${result.score} (${result.reasons ? result.reasons.join(', ') : ''})`);
      console.log(`Second-best score: ${_lastSecondScore || 'none'}`);
      console.log(`Selected row: "${result.matched.slice(0, 120)}"`);
      if (_lastSecondText) {
        console.log(`Second-best row: "${_lastSecondText.slice(0, 120)}"`);
      }

      // ── Content-based locator (Apr 16, third pass) ───────────────────────
      // Returning `page.locator('[data-target-class="yes"]').first()` made every
      // downstream op fail with a 5 s timeout the moment Bubble re-rendered the
      // schedule and stripped our data-* stamp.  Switch to a content-based
      // locator that Playwright re-resolves on every op: as long as the DOM
      // still contains the title + time + instructor signals around a button /
      // link, the locator keeps working across re-renders.
      //
      // We use `.filter({ has: buttonLocator })` to require a button/link
      // descendant (so inner text-only wrappers are excluded — solves the
      // Apr 16 AM tie-break bug from a second angle), then `.last()` to pick
      // the deepest ancestor (the most specific card, not an outer page
      // wrapper).  If multiple distinct rows match (same class listed twice),
      // `.last()` picks the last-in-DOM one; the existing modal-verify step
      // still rejects wrong-class clicks as a safety net.
      const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const buttonLoc = page.locator('button, [role="button"], a');
      let contentLoc = page.locator('*')
        .filter({ hasText: new RegExp(escRx(classTitle), 'i') });
      const _tm = (classTimeNorm || '').match(/^(\d+:\d+)\s*([ap])/i);
      if (_tm) {
        // Use just the hh:mm fragment for filtering — display formats vary
        // ("12:00 PM", "12:00 p", "12:00 pm") but hh:mm is consistent.
        contentLoc = contentLoc.filter({ hasText: new RegExp(escRx(_tm[1]), 'i') });
      }
      if (instructorFirstName) {
        contentLoc = contentLoc.filter({ hasText: new RegExp(escRx(instructorFirstName), 'i') });
      }
      contentLoc = contentLoc.filter({ has: buttonLoc });

      // ── Size guard (Apr 17 evening, Task #59) ────────────────────────────
      // `.last()` picks the deepest match, but in some Bubble.io renders the
      // content filters bubble up to a page-level wrapper (the schedule embed
      // root, or a top promo banner) that happens to contain ALL the title /
      // time / instructor text plus a button descendant somewhere.  Returning
      // that page-sized element makes Playwright click somewhere in the middle
      // of the viewport — which lands on whatever class card happens to render
      // there (e.g. Rise & Align Yoga 6:15 AM was clicked instead of the
      // Flow Yoga 12:00 PM target on Apr 16).
      //
      // Walk the matches from deepest → shallowest and return the first whose
      // bounding box looks card-sized (width < viewport width, height ≤ 400 px).
      // Reject candidates that are page-wide or taller than a single class row.
      const all = await contentLoc.all();
      if (all.length === 0) {
        return contentLoc.last(); // nothing to choose — let downstream fail naturally
      }
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      // Iterate deepest-first (Playwright returns DOM order; deepest match is .last()).
      for (let i = all.length - 1; i >= 0; i--) {
        const cand = all[i];
        let box = null;
        try { box = await cand.boundingBox({ timeout: 500 }); } catch {}
        if (!box) continue;
        const tooWide = box.width >= vp.width;
        const tooTall = box.height > 400;
        if (tooWide || tooTall) {
          console.log(`  ⚠️ content-locator size guard: rejecting candidate [${i}] box=${JSON.stringify(box)} (vp.width=${vp.width}, tooWide=${tooWide}, tooTall=${tooTall})`);
          continue;
        }
        return cand;
      }
      // None of the candidates were card-shaped — return null so the caller
      // falls through to the existing `data-target-class` attribute path
      // (or fails cleanly) instead of clicking a page-level wrapper.
      console.log(`  ⚠️ content-locator size guard: all ${all.length} candidate(s) were page-sized — returning null, caller will fall back to attribute locator`);
      return null;
    }

    // Cached centre of the scroll panel for the current run.  Populated on the
    // first incremental scrollSchedulePanel call and reused for every subsequent
    // step.  The panel's viewport position is stable throughout the discovery
    // scan (tab clicks and scrollTop resets do not move the element), so one
    // lookup per run is sufficient — eliminates 229 redundant querySelectorAll
    // walks across a full 230-step discovery scan.
    let _scrollPanelCenter = null;

    // Scroll the LARGEST VISIBLE scrollable panel (the schedule list) by `amount` px.
    // Uses mouse.wheel() to fire native scroll events that Bubble.io's virtual
    // RepeatingGroup listens to for re-rendering.  Direct scrollTop writes are silent
    // and don't trigger re-renders — so we wheel-scroll instead.
    async function scrollSchedulePanel(amount) {
      if (amount < -10000) {
        // RESET: use both direct scrollTop (fast) and a large upward wheel (fires events).
        await page.evaluate(() => {
          let best = null, bestH = 0;
          for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if (s.overflowY !== 'auto' && s.overflowY !== 'scroll' &&
                s.overflow  !== 'auto' && s.overflow  !== 'scroll') continue;
            if (el.scrollHeight <= el.clientHeight + 50) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 100) continue;
            if (r.height > bestH) { best = el; bestH = r.height; }
          }
          if (best) { best.scrollTop = 0; best.dispatchEvent(new Event('scroll', { bubbles: true })); }
        });
        // Do NOT clear _scrollPanelCenter: a scrollTop reset does not move the
        // panel in the viewport — only its scroll position changes.
        return;
      }

      // INCREMENTAL: use page.mouse.wheel() so Bubble.io fires scroll/virtual-scroll events.
      // Move mouse to the cached centre of the schedule panel before wheeling.
      if (!_scrollPanelCenter) {
        _scrollPanelCenter = await page.evaluate(() => {
          let best = null, bestH = 0;
          for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if (s.overflowY !== 'auto' && s.overflowY !== 'scroll' &&
                s.overflow  !== 'auto' && s.overflow  !== 'scroll') continue;
            if (el.scrollHeight <= el.clientHeight + 50) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 100) continue;
            if (r.height > bestH) { best = el; bestH = r.height; }
          }
          if (!best) return null;
          const r = best.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        if (_scrollPanelCenter) {
          console.log(`  [scrollPanel] Panel centre cached at (${_scrollPanelCenter.x}, ${_scrollPanelCenter.y})`);
        }
      }
      const center = _scrollPanelCenter;
      if (center) {
        await page.mouse.move(center.x, center.y);
        await page.mouse.wheel(0, amount);
      } else {
        // Fallback: wheel at the middle of the viewport.
        const vp = page.viewportSize();
        await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
        await page.mouse.wheel(0, amount);
      }
    }

    // After a tab click: immediate DOM search → slow-scroll retry if not found.
    async function findCardOnTab(tabLabel) {
      await page.waitForTimeout(400); // let the tab panel settle (reduced from 1000 ms)

      // Attempt 1: find in DOM without any scrolling.
      let card = await findTargetCard();
      if (card) return card;

      console.log(`  Not found immediately — resetting panel and scrolling to find card on ${tabLabel}...`);

      // Diagnostic: snapshot + dump TRULY VIEWPORT-VISIBLE time strings.
      // Use getBoundingClientRect() so we only log what's actually on screen —
      // offsetWidth/Height is layout size and includes off-screen scroll content.
      await snap(`scroll-top-${tabLabel.replace(/\s+/g, '-')}`);
      const visTimeCls = await page.evaluate(() => {
        const timeRe = /\d{1,2}:\d{2}/;
        const vw = window.innerWidth, vh = window.innerHeight;
        return [...document.querySelectorAll('*')]
          .filter(e => {
            if (e.children.length !== 0) return false;
            if (!timeRe.test(e.textContent)) return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= vh
                && r.left >= 0 && r.right <= vw;
          })
          .slice(0, 20)
          .map(e => e.textContent.trim().slice(0, 60));
      }).catch(() => []);
      console.log(`  Viewport-visible times at top: ${JSON.stringify(visTimeCls)}`);

      // Diagnostic: find what element scrollSchedulePanel would use.
      const scrollInfo = await page.evaluate(() => {
        let best = null, bestH = 0;
        for (const el of document.querySelectorAll('*')) {
          const s = getComputedStyle(el);
          if (s.overflowY !== 'auto' && s.overflowY !== 'scroll' &&
              s.overflow  !== 'auto' && s.overflow  !== 'scroll') continue;
          if (el.scrollHeight <= el.clientHeight + 50) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 100) continue;
          if (r.height > bestH) { best = el; bestH = r.height; }
        }
        if (!best) return { found: false, scrollTop: null, scrollHeight: null, clientHeight: null };
        return { found: true, tag: best.tagName, cls: best.className.slice(0, 80),
                 scrollTop: best.scrollTop, scrollHeight: best.scrollHeight,
                 clientHeight: best.clientHeight, h: Math.round(best.getBoundingClientRect().height) };
      }).catch(() => ({ found: false }));
      console.log(`  Scroll container: ${JSON.stringify(scrollInfo)}`);

      // Phase 1: Scroll UP from the current position.
      // Clicking the day tab lands at the afternoon/evening classes (e.g. 2:45 PM on Wed 08).
      // The 7:45 AM target is EARLIER in the day, so we must go backward first.
      const STEP_PX     = 80;
      const MAX_UP      = 80;   // 80 × 80px = 6400px backward — covers midnight→2:45 PM gap
      const MAX_DOWN    = 150;  // 150 × 80px = 12 000px forward — full week sweep

      // Signal-driven inter-step wait.  After mouse.wheel() the browser fires
      // Bubble.io's scroll listener synchronously, which schedules a virtual-list
      // DOM update for the next animation frame.  Yielding two rAFs (≈32 ms at
      // 60 fps) guarantees the re-render has been applied before we scan.  A
      // 100 ms hard cap protects against rare slow renders without falling all
      // the way back to the old 200 ms blanket wait.  Typical saving: ≈168 ms
      // per step → up to 38 s across a full 230-step scan.
      const awaitRender = () => page.evaluate(() => new Promise(resolve => {
        let n = 0;
        const tick = () => (++n >= 2 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
        setTimeout(resolve, 100); // hard cap
      }));

      console.log(`  Phase 1: scrolling UP ${MAX_UP} steps to find AM class above current position...`);
      for (let step = 0; step < MAX_UP; step++) {
        await scrollSchedulePanel(-STEP_PX);
        await awaitRender();
        card = await findTargetCard();
        if (card) {
          console.log(`  Found card after ${step + 1} upward scroll step(s).`);
          return card;
        }
        if (step === 29) {
          const midTimes = await page.evaluate(() => {
            const timeRe = /\d{1,2}:\d{2}/;
            const vh = window.innerHeight;
            return [...document.querySelectorAll('*')]
              .filter(e => {
                if (e.children.length !== 0) return false;
                if (!timeRe.test(e.textContent)) return false;
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= vh;
              })
              .slice(0, 15)
              .map(e => e.textContent.trim().slice(0, 60));
          }).catch(() => []);
          await snap(`scroll-up30-${tabLabel.replace(/\s+/g, '-')}`);
          console.log(`  [up step 30] Visible times: ${JSON.stringify(midTimes)}`);
        }
      }

      // Phase 2: Reset to top and sweep downward.
      console.log(`  Phase 2: resetting to top and scrolling DOWN ${MAX_DOWN} steps...`);
      await scrollSchedulePanel(-999999);
      await awaitRender(); // wait for top-reset re-render before starting downward scan

      for (let step = 0; step < MAX_DOWN; step++) {
        await scrollSchedulePanel(STEP_PX);
        await awaitRender();
        card = await findTargetCard();
        if (card) {
          console.log(`  Found card after ${step + 1} downward scroll step(s).`);
          return card;
        }
        // Mid-scroll diagnostic at step 30 (≈2400 px): snapshot + viewport-visible times.
        if (step === 29) {
          const midTimes = await page.evaluate(() => {
            const timeRe = /\d{1,2}:\d{2}/;
            const vh = window.innerHeight;
            return [...document.querySelectorAll('*')]
              .filter(e => {
                if (e.children.length !== 0) return false;
                if (!timeRe.test(e.textContent)) return false;
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= vh;
              })
              .slice(0, 15)
              .map(e => e.textContent.trim().slice(0, 60));
          }).catch(() => []);
          await snap(`scroll-mid-${tabLabel.replace(/\s+/g, '-')}`);
          console.log(`  [down step 30] Visible times mid-scroll: ${JSON.stringify(midTimes)}`);
        }
      }

      console.log(`  Reached scroll limit on ${tabLabel} without finding card.`);
      return null;
    }

    // Step 3: Find the target day tab then find the class card within it.
    const dayTabs = page.locator(`text=/${dayShort} \\d+/`);
    const dayTabCount = await dayTabs.count();
    console.log(`Searching ${dayTabCount} "${dayShort}" tab(s) on the schedule page.`);
    let targetCard = null;

    // Track the best tab to re-click during polling (prefer exact date match).
    let pollTabIndex = 0;
    let pollTabText  = '';

    // Try exact date tab first, then fall back to scanning all matching day tabs.
    if (targetDayNum !== null) {
      let exactTabClicked = false;
      for (let w = 0; w < dayTabCount; w++) {
        const tabText = await dayTabs.nth(w).textContent();
        const tabNum  = parseInt(tabText.replace(/\D+/g, ''), 10);
        if (tabNum === targetDayNum) {
          pollTabIndex = w;
          pollTabText  = tabText.trim();
          console.log('Clicking exact date tab: ' + tabText.trim());
          await dayTabs.nth(w).click();
          // 300 ms settle for the nearOpen quick-scan path; for the non-nearOpen
          // path findCardOnTab() adds its own settle wait, so total stays ~700 ms
          // instead of the previous 2000 ms (two consecutive 1000 ms pauses).
          await page.waitForTimeout(300);

          // Check if we're close to the booking window opening (approaching from the future).
          // If so, skip the 90-second scroll scan — we'll enter poll mode shortly anyway.
          // IMPORTANT: only skip scroll when the window is *upcoming* (msUntilOpen > 0).
          // When phase=late (booking already passed), the class IS on the schedule and
          // needs a full scroll scan to find it — the partial-render quick scan misses it.
          let nearOpen = false;
          try {
            const { bookingOpen: bwChk } = getBookingWindow(job);
            const msUntilBwChk = bwChk ? (bwChk.getTime() - Date.now()) : Infinity;
            nearOpen = bwChk && msUntilBwChk > 0 && msUntilBwChk < 15 * 60 * 1000;
          } catch { /* ignore */ }

          if (nearOpen) {
            // Quick scan only — polling will handle the precise timing
            targetCard = await findTargetCard();
            if (targetCard) {
              _tc.cardFoundAt = new Date().toISOString();
              console.log('Found class on exact date tab (quick scan): ' + tabText.trim());
            } else {
              console.log('Class not yet visible (within 15 min of open) — going to poll mode.');
            }
          } else {
            targetCard = await findCardOnTab(tabText.trim());
            if (targetCard) {
              _tc.cardFoundAt = new Date().toISOString();
              console.log('Found class on exact date tab: ' + tabText.trim());
            } else {
              console.log('Class not on exact date tab — will try polling if within booking window.');
            }
          }
          exactTabClicked = true;
          break;
        }
      }
      if (!exactTabClicked) {
        console.log(`Exact tab for day ${targetDayNum} not visible — falling back to full scan.`);
      }
    }

    // Fallback: scan all matching day tabs in order.
    // Skip if the booking window is UPCOMING and within 15 min — slow scroll scans
    // waste time when polling is about to start.  Do NOT skip when phase=late (already
    // past open): the class is on the schedule and needs scrolling to be found.
    if (!targetCard) {
      let skipFallback = false;
      try {
        const { bookingOpen: bwCheck } = getBookingWindow(job);
        const msUntilFallback = bwCheck ? (bwCheck.getTime() - Date.now()) : Infinity;
        if (bwCheck && msUntilFallback > 0 && msUntilFallback < 15 * 60 * 1000) {
          console.log('Within 15 min of booking open — skipping fallback scroll scan, going to poll mode.');
          skipFallback = true;
          if (!pollTabText && dayTabCount > 0) {
            pollTabText  = (await dayTabs.nth(0).textContent()).trim();
            pollTabIndex = 0;
          }
        }
      } catch { /* ignore — booking-window calc failed, run fallback normally */ }

      if (!skipFallback) {
        for (let w = 0; w < dayTabCount; w++) {
          const tabText = await dayTabs.nth(w).textContent();
          if (!pollTabText) { pollTabIndex = w; pollTabText = tabText.trim(); }
          console.log('Trying tab: ' + tabText.trim());
          await dayTabs.nth(w).click();
          targetCard = await findCardOnTab(tabText.trim());
          if (targetCard) {
            _tc.cardFoundAt = new Date().toISOString();
            console.log('Found class on ' + tabText.trim());
            break;
          }
          console.log('Class not found on ' + tabText.trim() + ', trying next tab...');
        }
      }
    }

    // Initial tab scan complete — record discovery end before entering poll mode.
    _tc.class_discovery_done = new Date().toISOString();

    // ── HOLD-AND-POLL ────────────────────────────────────────────────────────
    // If the class still isn't visible, check whether the booking window opens
    // within the next 15 minutes.  If so, keep the browser alive, sleep until
    // exactly the opening second, then poll every 5 seconds until the card
    // appears (or up to 20 minutes after the open time).
    //
    // This is the core sniper mechanic: we pre-warm the browser (login +
    // navigate + filters) during warmup phase, then click the instant the
    // YMCA unlocks the class — rather than starting a cold browser run at
    // open time and arriving 3 minutes late.
    // ─────────────────────────────────────────────────────────────────────────
    if (!targetCard && pollTabText) {
      let bwOpen;
      try {
        ({ bookingOpen: bwOpen } = getBookingWindow(job));
      } catch (e) {
        bwOpen = null;
      }

      const POLL_LEAD_MS       = 15 * 60 * 1000; // start polling if open is ≤15 min away
      const POLL_TIMEOUT_MS    = 20 * 60 * 1000; // give up 20 min after open
      const POLL_PRE_SLEEP_MS  =  5 * 1000;      // threshold: enter active poll within 5s of open
      const POLL_POST_SLEEP_MS =  2 * 1000;      // retry every 2s once window is open
      const msUntilOpen        = bwOpen ? (bwOpen.getTime() - Date.now()) : Infinity;

      if (bwOpen && msUntilOpen < POLL_LEAD_MS) {
        // ── Record when the booking window is expected to open ────────────────
        _tc.bookingOpenAt = bwOpen.toISOString();

        const openStr = bwOpen.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit' });
        console.log(`\n⏳ Booking window opens at ${openStr} PT (${Math.round(msUntilOpen / 1000)}s away) — entering hold-and-poll mode.`);
        console.log(`   Will re-click "${pollTabText}" tab every ${POLL_POST_SLEEP_MS / 1000}s once open, until class appears or ${POLL_TIMEOUT_MS / 60000} min after open.\n`);

        const pollDeadline = bwOpen.getTime() + POLL_TIMEOUT_MS;
        let attempt = 0;

        while (!targetCard && Date.now() < pollDeadline) {
          attempt++;
          const msLeft = bwOpen.getTime() - Date.now();

          if (msLeft > POLL_PRE_SLEEP_MS) {
            // Still before open — sleep in chunks (wake up 1 s early to be ready)
            const sleepMs = Math.min(msLeft - 1000, 10000); // max 10 s sleep chunk
            console.log(`  [poll #${attempt}] ${Math.round(msLeft / 1000)}s until open — sleeping ${Math.round(sleepMs / 1000)}s...`);
            await page.waitForTimeout(sleepMs);
            continue; // re-evaluate timing, don't click yet
          }

          // At or past opening time: re-click the tab and scan
          _tc.pollAttemptsPostOpen++;
          // Replay: window_open fires once on the first post-open poll
          if (_tc.pollAttemptsPostOpen === 1) replayStore.addEvent(_jobId, 'window_open', 'Window opened', `Booking window opened at ${openStr}`);
          console.log(`  [poll #${attempt}] Clicking "${pollTabText}" tab (${msLeft > 0 ? Math.round(msLeft / 1000) + 's before open' : Math.round(-msLeft / 1000) + 's after open'})...`);
          try {
            await dayTabs.nth(pollTabIndex).click();
          } catch {
            // Tab locator stale — re-query
            const freshTabs = page.locator(`text=/${dayShort} \\d+/`);
            if (await freshTabs.count() > pollTabIndex) await freshTabs.nth(pollTabIndex).click();
          }
          await page.waitForTimeout(400); // let Bubble.io re-render (reduced from 1000 ms)
          targetCard = await findTargetCard();
          if (targetCard) {
            _tc.cardFoundAt = new Date().toISOString();
            console.log(`\n✅ Class appeared on poll attempt #${attempt} — proceeding to register!\n`);
          } else {
            console.log(`  [poll #${attempt}] Not yet visible — waiting ${POLL_POST_SLEEP_MS / 1000}s...`);
            await page.waitForTimeout(POLL_POST_SLEEP_MS);
          }
        }

        if (!targetCard) {
          console.log(`⚠️ Poll timed out (${POLL_TIMEOUT_MS / 60000} min after open) — class never appeared.`);
        }
      } else if (bwOpen) {
        console.log(`Booking window opens in ${Math.round(msUntilOpen / 60000)} min — too far away to poll. Exiting for scheduler retry.`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!targetCard) {
      const msg = _wcPrefix + `Could not find visible row matching ${classTitle} / ${classTimeNorm || classTime} / ${instructor || 'Stephanie'} on ${dayShort} ${targetDayNum || '(any)'}.`;
      console.log(msg);
      await captureFailure('scan', 'class_not_found');
      const _topSignals = (_lastAllTexts || []).slice(0, 3).map(r => r.txt.slice(0, 60)).join(' | ');
      emitFailure('DISCOVERY', 'DISCOVERY_EMPTY', msg, {
        evidence: { ...(_topSignals ? { nearMisses: _topSignals } : {}) }
      });
      // When filters never established a trustworthy filtered view, a not_found
      // outcome is unverifiable — the class may simply not have been rendered.
      // Re-classify so downstream logs/UI can tell the difference.
      if (filtersFailed) {
        const filterMsg = `Could not verify class presence — schedule filters failed to apply; scan ran on unfiltered content. Class may exist but was not rendered. Original: ${msg}`;
        return logRunSummary({ status: 'error', message: filterMsg, screenshotPath, phase: 'scan', reason: 'filter_apply_failed', category: 'scan', label: 'Could not verify class — filters failed', url: page.url() });
      }
      return logRunSummary({ status: 'not_found', message: msg, screenshotPath, phase: 'scan', reason: 'class_not_found', category: 'scan', label: 'No matching class card found', url: page.url() });
    }

    // Card confirmed on schedule — mark discovery ready before proceeding to modal.
    _state.bundle.discovery = 'DISCOVERY_READY';
    await captureDebug('scan', 'card_found');
    emitEvent(_state, 'DISCOVERY', null, 'Class found on schedule', {
      evidence: {
        matched:  _lastBestText.slice(0, 80),
        score:    String(_lastBestScore),
        signals:  (_lastBestReasons || []).join(', '),
        ...(_lastSecondText ? { second: _lastSecondText.slice(0, 80) } : {}),
      }
    });
    // Replay: class card identified and verified
    if (!PREFLIGHT_ONLY) replayStore.addEvent(_jobId, 'target_acquired', 'Class identified', classTitle);

    // ── STAGE 3: uncertain_identity — borderline card confidence ─────────────
    // Score is exactly at CONFIDENCE_THRESHOLD (8) — only 2 signals matched
    // (title+instructor but no time, or time+instructor but no title).
    // Capture once so the matched card can be visually inspected.
    if (_lastBestScore <= CONFIDENCE_THRESHOLD) {
      console.log(`⚠️ Card matched at minimum confidence (score=${_lastBestScore}/${CONFIDENCE_THRESHOLD}) — capturing uncertainty screenshot.`);
      await captureFailure('scan', 'uncertain_identity');
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── CLICK + VERIFY HELPER ────────────────────────────────────────────────
    // Scrolls the card into view, clicks its interactive child (button/link/
    // cursor:pointer fallback → force-click last resort), waits for the modal
    // to render, and verifies that the opened modal shows the expected time and
    // instructor.  Returns { ok: true } on success or
    // { ok: false, failMsg, reasonTag } on verification failure.
    // Never throws — all errors are returned as { ok: false }.
    // ────────────────────────────────────────────────────────────────────────────
    async function attemptClickAndVerify(card, candidateLabel) {
      // Set to true when the in-function T003 promotion swaps `card` to the
      // second-best candidate.  Bubbled up via the return value so the outer
      // caller can skip its own second-best fallback retry (which would
      // double-attempt the same card and could misclassify the outcome as
      // "both candidates had the wrong time" when only one was tried).
      let _usedSecondBest = false;
      try {
        // NOTE: findTargetCard now returns a content-based locator (title +
        // time + instructor + has-button filter chain), not an attribute-based
        // one.  Playwright re-resolves this locator on every op, so Bubble
        // re-renders that strip data-* attributes no longer break the click
        // path — the earlier marker-presence probe is no longer needed.  The
        // detach-recovery path below still catches the rarer case where the
        // DOM simply has no matching element (e.g. schedule cleared entirely).
        // Scroll card into view
        try {
          await card.scrollIntoViewIfNeeded({ timeout: 5000 });
        } catch (scrollErr) {
          console.log(`⚠️ [${candidateLabel}] scrollIntoViewIfNeeded timed out:`, scrollErr.message.split('\n')[0]);
        }
        await page.waitForTimeout(300);
        // Use 5s timeouts: Bubble.io may re-render and strip the data-target-class
        // attribute between findTargetCard()'s page.evaluate() and this locator call.
        // A 5s timeout caps the hang at 5s and surfaces a clear error rather than
        // silently blocking for 30s.
        const [isVis, box] = await Promise.all([
          card.isVisible({ timeout: 5000 }).catch(() => false),
          card.boundingBox({ timeout: 5000 }).catch(() => null),
        ]);
        console.log(`Card visible (${candidateLabel}):`, isVis, '| box:', JSON.stringify(box));
        if (!isVis && !box) {
          // Element was detached — Bubble.io re-rendered the DOM between findTargetCard()
          // and here (common during class-list refresh near booking-open time).
          // Attempt one local recovery: re-run the scan immediately to get a fresh
          // element reference instead of propagating the error to the caller, which
          // would fall back to the second-best candidate (potentially equally stale).
          //
          // ── Self-Healing / Safe Recovery Pass — Stage 4: stale-DOM re-target ──
          // pageHealth = stale_dom. This block is the ONE bounded re-target attempt.
          // Bound is enforced by the existing single-attempt structure (no loop),
          // and the post-rescan IDENTITY GATE below ensures the recovered element
          // must restore trust before we proceed to click. If identity is not
          // restored (score downgraded, target time not present in matched text),
          // we bail with a truthful stale_dom_untrusted reason instead of clicking.
          console.log(`⚠️ [${candidateLabel}] Card detached — attempting local re-scan for fresh element... (stage-4 pageHealth=stale_dom)`);
          const _preRescanScore = _lastBestScore;
          const _preRescanText  = _lastBestText;
          const recoveredCard = await findTargetCard();
          if (!recoveredCard) {
            console.log(`❌ [${candidateLabel}] Local recovery: re-scan returned no candidate`);
            return { ok: false, failMsg: 'Card element detached; local re-scan found no candidate', reasonTag: 'error', recorded: false, usedSecondBest: _usedSecondBest };
          }
          console.log(`  Re-scan found fresh element — scrolling into view for re-check`);
          try {
            await recoveredCard.scrollIntoViewIfNeeded({ timeout: 5000 });
          } catch (_) {}
          await page.waitForTimeout(300);
          const [recVis, recBox] = await Promise.all([
            recoveredCard.isVisible({ timeout: 3000 }).catch(() => false),
            recoveredCard.boundingBox({ timeout: 3000 }).catch(() => null),
          ]);
          if (!recVis && !recBox) {
            console.log(`❌ [${candidateLabel}] Recovered element also detached after re-scan`);
            return { ok: false, failMsg: 'Card detached twice; recovered element also not visible', reasonTag: 'error', recorded: false, usedSecondBest: _usedSecondBest };
          }

          // ── Stage 4: identity re-validation gate ──────────────────────────
          // The recovered card just survived a Bubble re-render. We must NOT
          // assume it is still our target — a same-time neighbor could now sit
          // where our card used to sit. Re-validate identity using the same
          // signals findTargetCard() exposes via _lastBest* globals:
          //   (a) post-rescan confidence must still meet CONFIDENCE_THRESHOLD
          //   (b) post-rescan score must NOT downgrade (no silent weaker match)
          //   (c) target time string must appear in the post-rescan matched text
          // Any failure → bail safely with stale_dom_untrusted, no click.
          const postRescanScore = _lastBestScore;
          const postRescanText  = _lastBestText || '';
          const _normTimeForCheck = (classTimeNorm || classTime || '').toString().trim();
          const _timePresent = _normTimeForCheck
            ? postRescanText.toLowerCase().includes(_normTimeForCheck.toLowerCase())
            : true; // no target time configured → don't gate on it
          const identityOk =
            postRescanScore >= CONFIDENCE_THRESHOLD &&
            postRescanScore >= _preRescanScore &&
            _timePresent;
          if (!identityOk) {
            console.log(`❌ [${candidateLabel}] [stale_dom_untrusted] Recovered card failed identity re-validation — preScore=${_preRescanScore}, postScore=${postRescanScore}, timePresent=${_timePresent}, target="${_normTimeForCheck}", matched="${postRescanText.slice(0, 80)}"`);
            await captureFailure('scan', 'stale_dom_untrusted');
            return {
              ok: false,
              failMsg: `Card detached; re-scan returned a candidate that failed identity re-validation (score ${_preRescanScore}→${postRescanScore}, time match=${_timePresent}). Refusing to click on untrusted refreshed card.`,
              reasonTag: 'stale_dom_untrusted',
              recorded: false,
              usedSecondBest: _usedSecondBest,
            };
          }
          console.log(`✅ [${candidateLabel}] Local recovery succeeded — identity re-validated (score ${_preRescanScore}→${postRescanScore}, time match=${_timePresent}); proceeding with fresh element`);
          card = recoveredCard; // reassign: all downstream code in this function uses `card`
        }

        // Step 1: prefer button / [role="button"] / <a> inside the card
        const clickable    = card.locator("button, [role='button'], a").first();
        const hasClickable = (await clickable.count()) > 0;

        let clickTarget, clickDesc;
        if (hasClickable) {
          clickTarget = clickable;
          clickDesc   = 'button/[role=button]/a child';
        } else {
          // No interactive child under the matched element.  With the T002 tie-break
          // fix this should be rare — usually the scorer picked an inner text wrapper
          // that slipped past visibility guards.  Log loudly so we can spot it.
          console.log(`⚠️ [${candidateLabel}] Matched element has NO button/[role=button]/a child.`);

          // ── T003 guard: prefer second-best card if it has a clickable child ──
          // findTargetCard() marks the runner-up with data-target-class-second.
          // Switching to it before the cursor:pointer hunt avoids the failure mode
          // observed Apr 16 (click landed on an inner non-interactive node, then
          // the cursor:pointer fallback navigated to a class detail page instead
          // of opening the signup modal).
          const secondCard           = page.locator('[data-target-class-second="yes"]').first();
          const secondCount          = await secondCard.count().catch(() => 0);
          const secondHasClickable   = secondCount > 0
            ? (await secondCard.locator("button, [role='button'], a").count().catch(() => 0)) > 0
            : false;

          if (secondHasClickable) {
            // Verify the promoted card is still attached/visible before swapping.
            // Bubble.io can re-render between the count() above and the click —
            // fall through to cursor:pointer hunt rather than committing to a
            // stale element that will only fail at click time.
            try { await secondCard.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch (_) {}
            await page.waitForTimeout(200);
            const [secVis, secBox] = await Promise.all([
              secondCard.isVisible({ timeout: 2000 }).catch(() => false),
              secondCard.boundingBox({ timeout: 2000 }).catch(() => null),
            ]);

            if (secVis || secBox) {
              console.log(`✅ [${candidateLabel}] Second-best card has a clickable child — switching to it instead of cursor:pointer hunt.`);
              emitEvent(_state, 'ACTION', null, 'Second-best card promoted (winner had no clickable child)', {
                evidence: { reason: 'winner_no_clickable_child', usedSecondBest: 'true' }
              });
              _usedSecondBest = true;
              card        = secondCard;
              clickTarget = secondCard.locator("button, [role='button'], a").first();
              clickDesc   = 'second-best card → button/[role=button]/a child';
            } else {
              console.log(`⚠️ [${candidateLabel}] Second-best card detached after marker check — falling through to cursor:pointer hunt on original.`);
              emitEvent(_state, 'ACTION', null, 'Second-best card detached before promotion', {
                evidence: { reason: 'second_best_detached' }
              });
              // fall into the cursor:pointer hunt branch below
            }
          }
          if (!_usedSecondBest) {
            console.log(`⚠️ [${candidateLabel}] No usable second-best card — falling back to cursor:pointer hunt (may land on a detail-page link instead of signup).`);
            // Step 2: cursor:pointer child — evaluate directly on the card element
            const markedPointer = await card.evaluate(el => {
              for (const child of el.querySelectorAll('*')) {
                const r = child.getBoundingClientRect();
                if (r.width < 20 || r.height < 10) continue;
                if (getComputedStyle(child).cursor === 'pointer') {
                  child.setAttribute('data-click-target', 'yes');
                  return true;
                }
              }
              return false;
            });
            if (markedPointer) {
              clickTarget = page.locator('[data-click-target="yes"]').first();
              clickDesc   = 'cursor:pointer child';
              // Do NOT remove the attribute here — the locator depends on it.
              // Cleanup happens below after the click attempt.
            } else {
              // Step 3: force-click the card itself as last resort
              clickTarget = card;
              clickDesc   = 'card itself (last resort force click)';
            }
          }
        }

        console.log(`Clicking: ${clickDesc}`);
        if (DEBUG_HIGHLIGHT) {
          await highlightElement(page, clickTarget);
          await page.waitForTimeout(400);
        }
        if (DEBUG_PAUSE) {
          console.log('⏸  Pausing before click — Playwright Inspector is open.');
          console.log('👉 Hover elements, test selectors, then press Resume to continue.');
          await page.pause();
        }
        _tc.card_click_start = new Date().toISOString();
        try {
          await clickTarget.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await clickTarget.click({ timeout: 5000 });
        } catch (clickErr) {
          // Distinguish marker-stripped (Bubble re-render cleared data-target-class
          // between set and click) from a real click failure.  Playwright's locator
          // timeout message always mentions the failing selector, so matching on it
          // is reliable.
          const markerStripped = /data-target-class(?:-second)?\s*=/.test(clickErr.message || '');
          const failLabel = markerStripped
            ? 'Marker attribute stripped by re-render before click landed'
            : 'Normal click failed — using force click';
          const failReason = markerStripped ? 'click_marker_stripped' : 'click_fallback';
          console.log(`⚠️ Normal click failed (${candidateLabel})${markerStripped ? ' [marker-stripped]' : ''}, force-clicking:`, clickErr.message.split('\n')[0]);
          // ── Capture before emitting so screenshot ref is attached to event ─
          await captureFailure('click', markerStripped ? 'marker_stripped' : 'fallback_used');
          emitFailure('ACTION', 'ACTION_FORCE_CLICK_USED', `Normal click failed — force-click fallback (${candidateLabel})`);
          // ─────────────────────────────────────────────────────────────────
          // ── POINT 5: click — fallback to force click ──────────────────────
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'click', reason: failReason,
            category: 'click', label: failLabel,
            message:  clickErr.message.split('\n')[0],
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  { candidateLabel, clickDesc, markerStripped },
          });
          // ─────────────────────────────────────────────────────────────────
          await card.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await card.click({ force: true });
        }
        _tc.card_click_done = new Date().toISOString();
        // Clean up the data-click-target attribute now that the click is done.
        await page.evaluate(() =>
          document.querySelectorAll('[data-click-target]').forEach(e => e.removeAttribute('data-click-target'))
        ).catch(() => {});

        // Signal-driven modal wait: wait for [role="dialog"] to appear first
        // (capped at 3 s), which avoids being fooled by the FamilyWorks page-
        // header "Login" button that is always present regardless of modal state.
        // Falls back gracefully — we proceed even if no dialog appears.
        _tc.modal_wait_start = new Date().toISOString();
        const _dialogHandle = await page.waitForSelector('[role="dialog"]', { timeout: 3000 }).catch(() => null);
        _tc.modal_ready_at  = new Date().toISOString(); // dialog in DOM — BEFORE settle

        if (_dialogHandle) {
          // Dialog appeared — additionally wait up to 500 ms for action buttons
          // to render inside it, so the text-ready check below has a real button
          // to walk from rather than the header Login button.
          await page.waitForSelector(
            ACTION_SELECTORS.modalReady.split(', ').map(s => `[role="dialog"] ${s}`).join(', '),
            { timeout: 500 }
          ).catch(() => null);
        } else {
          // No [role="dialog"] found — fall back to any page-level match (legacy path)
          await page.waitForSelector(ACTION_SELECTORS.modalReady, { timeout: 500 }).catch(() => null);
        }

        // Stage 5: Replace the flat 300ms settle with a signal-driven text-ready wait.
        // The action button appeared, but Bubble.io may populate modal text (class
        // time, instructor) slightly later.  Wait until the button's ancestor
        // container has >80 chars of textContent — the same 12-ancestor walk and
        // threshold used by modal verification below.  Resolves as soon as text is
        // ready; caps at 400ms so the worst case is only slightly above the old
        // fixed 300ms, while the common case resolves in <100ms.
        // Scoped to [role="dialog"] first to avoid matching the page-header Login button.
        try {
          await page.waitForFunction((sel) => {
            const dialog = document.querySelector('[role="dialog"]');
            const btn = dialog ? dialog.querySelector(sel) : document.querySelector(sel);
            if (!btn) return true; // button gone — proceed; verification will handle it
            let node = btn.parentElement;
            for (let i = 0; i < 12 && node && node !== document.body; i++) {
              if ((node.textContent || '').trim().length > 80) return true;
              node = node.parentElement;
            }
            return false;
          }, ACTION_SELECTORS.modalReady, { timeout: 400 });
        } catch { /* cap reached — proceed regardless; verification falls back to body */ }

        _tc.modal_wait_done  = new Date().toISOString();
        _tc.modal_open_done  = _tc.modal_wait_done; // keep existing field for backward compat
        await captureDebug('modal', 'modal_opened');

        // Verify the modal matches expected time + instructor.
        // Normalize all whitespace variants (Bubble.io uses \u00A0 in time strings).
        _tc.modal_verify_start = new Date().toISOString();
        // Scope to the modal [role="dialog"] container first — this prevents the
        // FamilyWorks page-header "Login" button from being used as the anchor,
        // which would cause the ancestor walk to read page-header/nav text and
        // then fall back to document.body, potentially matching the time of a
        // DIFFERENT class (e.g. Chair Yoga 10:45a-11:45a end time matching "11:45 a").
        // Only if no [role="dialog"] is present does it fall back to page-wide search.
        // Bubble.io renders class times via CSS-styled elements; innerText is
        // layout-aware (respects visibility/display) and returns what the user
        // sees, while textContent may return empty for dynamically-rendered nodes.
        let modalText = await page.evaluate((modalSel) => {
          const norm = t => (t || '').replace(/[\u00A0\u2009\u202f]+/g, ' ').toLowerCase();
          const dialog = document.querySelector('[role="dialog"]');
          const btn = dialog ? dialog.querySelector(modalSel) : document.querySelector(modalSel);
          if (btn) {
            let node = btn.parentElement;
            for (let i = 0; i < 12 && node && node !== document.body; i++) {
              const txt = norm((node.innerText || node.textContent) || '').trim();
              if (txt.length > 80) return txt;
              node = node.parentElement;
            }
            // Walked out of modal without finding >80 chars — return dialog text
            // directly rather than falling back to full body (avoids false positives
            // from other classes in the schedule list).
            if (dialog) return norm((dialog.innerText || dialog.textContent) || '');
          }
          // Pre-open state: dialog IS present but no action button yet (e.g. "3 d until
          // open registration").  Scope text to the dialog element directly — do NOT
          // fall through to document.body which returns the entire schedule page and
          // causes the time/instructor check to match against other class cards.
          if (dialog) return norm((dialog.innerText || dialog.textContent) || '');
          return norm((document.body.innerText || document.body.textContent) || '');
        }, ACTION_SELECTORS.modalReady).catch(() => '');
        // If page.evaluate returned empty (Bubble.io async render / context lost),
        // fall back to Playwright-native innerText on the dialog or full body.
        if (!modalText || modalText.length < 10) {
          const _dlgTxt = await page.locator('[role="dialog"]').innerText({ timeout: 2000 }).catch(() => '');
          if (_dlgTxt && _dlgTxt.length >= 10) {
            modalText = _dlgTxt.replace(/[\u00A0\u2009\u202f]+/g, ' ').toLowerCase();
            console.log('[modal-text] innerText fallback used — dialog returned', modalText.length, 'chars');
          } else {
            const _bodyTxt = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
            modalText = (_bodyTxt || '').replace(/[\u00A0\u2009\u202f]+/g, ' ').toLowerCase();
            console.log('[modal-text] innerText fallback used — body returned', modalText.length, 'chars');
          }
        }
        // Capture a short window around the time match for the consolidated run summary.
        // Use the actual time digits from classTimeNorm (e.g. "7:45" or "4:20").
        const _timeDigits = classTimeNorm ? classTimeNorm.split(/\s/)[0] : '';
        const _tmIdx = _timeDigits ? modalText.indexOf(_timeDigits) : -1;
        _lastModalPreview = _tmIdx >= 0
          ? modalText.slice(Math.max(0, _tmIdx - 12), _tmIdx + 45).replace(/\s+/g, ' ').trim()
          : modalText.slice(0, 60);
        const verifyTime = !!classTimeNorm && modalText.includes(classTimeNorm);
        // Skip instructor check when no instructor was specified on the job (instructorFirstName === null).
        const verifyInst = instructorFirstName ? modalText.includes(instructorFirstName) : true;

        // ── Self-Healing / Safe Recovery Pass — Stage 5: title-presence gate ──
        // Time-only verification cannot distinguish two classes that happen to
        // run at the SAME hour (e.g. "Flow Yoga" 9:00 vs "Rise & Align Yoga"
        // 9:00 — the April 2026 wrong-class incident). Strengthen verification
        // by also requiring the target class title's distinguishing words to
        // appear in modalText. We require ALL words >=4 chars from classTitle
        // to be present (case-insensitive substring). Falls back open (skip)
        // if the title contains no words >=4 chars, so single-word/short
        // titles never get false-failed by an over-strict gate.
        const _titleWords = (classTitle || '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(w => w.length >= 4);
        const verifyTitle = _titleWords.length === 0
          ? true                                      // no usable words → don't gate
          : _titleWords.every(w => modalText.includes(w));
        const _missingTitleWords = _titleWords.filter(w => !modalText.includes(w));

        console.log(`Modal verification (${candidateLabel}) —`, JSON.stringify({ verifyTime, verifyInst, verifyTitle, classTimeNorm, instructorFirstName, classTitle, missingTitleWords: _missingTitleWords }));
        _tc.modal_verify_done = new Date().toISOString();

        // Time OR title mismatch = definitive fail (we clicked the wrong class).
        //   - Time mismatch:  modal opened on a different time slot
        //   - Title mismatch: same-time-different-class wrong-modal (Stage 5)
        // Instructor mismatch only = soft warning — instructor may be a substitute
        // this week; if time + title both match, identity is confirmed, proceed.
        // pageHealth = wrong_modal classification applies to either failure.
        if (!verifyTime || !verifyTitle) {
          let reasonTag;
          if (!verifyTime && !verifyTitle)        reasonTag = 'time-title';
          else if (!verifyTime)                   reasonTag = verifyInst ? 'time' : 'time-instructor';
          else                                    reasonTag = 'title';
          const reasonLabel = {
            'time':            'Time mismatch',
            'time-instructor': 'Time + Instructor mismatch',
            'title':           'Wrong class title in modal (same-time collision)',
            'time-title':      'Wrong class title AND time in modal',
          }[reasonTag] || 'Modal verification failed';
          console.log(`❌ Modal verification failed (${candidateLabel}):`, reasonLabel);
          const _ftMap = { 'time': 'VERIFY_TIME_MISMATCH', 'time-instructor': 'VERIFY_MISMATCH' };
          console.log('Expected:', { time: classTimeNorm, instructor: instructorFirstName });
          console.log('Modal preview:', modalText.slice(0, 300));
          // Capture before emitting so screenshot ref is attached to event.
          await captureFailure('verify', REASONTAG_TO_REASON[reasonTag] || 'unexpected_error');
          emitFailure('VERIFY', _ftMap[reasonTag] || 'VERIFY_MISMATCH', reasonLabel, { evidence: { candidateLabel, verifyTime, verifyInst } });
          if (screenshotPath) {
            try {
              const meta = {
                reason: reasonTag, expectedTime: classTimeNorm,
                expectedInstructor: instructorFirstName,
                classTitle: classTitle || null,
                modalPreview: modalText.slice(0, 300),
                timestamp: new Date().toISOString(),
              };
              fs.writeFileSync(screenshotPath.replace('.png', '.json'), JSON.stringify(meta, null, 2));
            } catch (e) { console.log('Meta write failed:', e.message); }
          }
          const failMsg = `Modal verification failed (${reasonTag}): expected time="${classTimeNorm}" (found:${verifyTime}) instructor="${instructorFirstName}" (found:${verifyInst})`;
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'verify', reason: REASONTAG_TO_REASON[reasonTag] || 'unexpected_error',
            category: 'verify', label: reasonLabel,
            message:  failMsg,
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            expected: JSON.stringify({ time: classTimeNorm, instructor: instructorFirstName }),
            actual:   modalText.slice(0, 300),
            context:  { candidateLabel, verifyTime, verifyInst, reasonTag, modalPreview: _lastModalPreview },
          });
          return { ok: false, failMsg, reasonTag, recorded: true, usedSecondBest: _usedSecondBest };
        }

        if (!verifyInst) {
          // Instructor mismatch with correct time — likely a substitute instructor.
          // Log a warning but do NOT block the booking / waitlist attempt.
          console.log(`⚠️ Modal: instructor mismatch for ${candidateLabel} (expected "${instructorFirstName}") — may be a substitute. Time verified; proceeding.`);
          emitEvent(_state, 'VERIFY', 'VERIFY_INSTRUCTOR_MISMATCH', 'Instructor mismatch (substitute?) — continuing', { evidence: { candidateLabel, verifyTime, verifyInst } });
        }

        console.log(`✅ Modal verified (${candidateLabel}) — proceeding to booking.`);
        // Card found, session valid, class discovered and identity confirmed
        emitEvent(_state, 'VERIFY', null, `Modal verified (${candidateLabel})`, { evidence: { verifyTime, verifyInst } });
        // Replay: booking form is open and identity confirmed
        if (!PREFLIGHT_ONLY) replayStore.addEvent(_jobId, 'modal_opened', 'Booking form opened', classTitle);
        _state.bundle.session   = 'SESSION_READY';
        _state.bundle.discovery = 'DISCOVERY_READY';
        _state.sniperState      = 'SNIPER_BOOKING';
        return { ok: true, usedSecondBest: _usedSecondBest };

      } catch (err) {
        const failMsg = `Unexpected error during click/verify (${candidateLabel}): ${err.message}`;
        console.log('❌', failMsg);
        // ── POINT 5/3: click — unexpected error ───────────────────────────
        recordFailure({
          jobId:    job.id || job.jobId || null,
          phase:    'click', reason: 'unexpected_error',
          category: 'click', label: 'Unexpected error during card click/verify',
          message:  err.message,
          classTitle,
          screenshot: _screenshotRef(screenshotPath),
          url:      (() => { try { return page.url(); } catch { return null; } })(),
          context:  { candidateLabel },
        });
        // ─────────────────────────────────────────────────────────────────
        if (PREFLIGHT_ONLY) {
          emitFailure('MODAL', 'MODAL_NOT_OPENED',
            `Preflight: modal unreachable — ${err.message.split('\n')[0]}`, {
            evidence: {
              url:            (() => { try { return page.url(); } catch { return ''; } })(),
              error:          err.message.split('\n')[0],
              candidateLabel,
            }
          });
        }
        return { ok: false, failMsg, reasonTag: 'error', recorded: true, usedSecondBest: _usedSecondBest };
      }
    }
    // ────────────────────────────────────────────────────────────────────────────

    // ── Schedule re-scrape verification ────────────────────────────────────────
    // After a Register/Waitlist click that produced an empty / ambiguous modal
    // (no Cancel button, no confirmation text, no Register/Waitlist re-appearing),
    // the bot historically had no authoritative way to know whether the click
    // actually booked the user. The April 2026 false-positive incident showed
    // why "guess it worked" is unsafe.
    //
    // The authoritative check FamilyWorks gives us is the modal itself: when a
    // class is NOT booked, opening the card shows a "Register" (or "Waitlist")
    // button. When it IS booked, it shows "View Reservation" / "Unregister" /
    // "Cancel Registration" / "Leave Waitlist" instead.
    //
    // So this helper closes any open modal, re-finds the same target card via
    // findTargetCard(), re-clicks it to open a fresh modal, and inspects the
    // visible buttons. Returns:
    //   { verified: true,  reason: 'reservation_or_cancel_visible', buttons }
    //   { verified: false, reason: 'register_still_visible',         buttons }
    //   { verified: null,  reason: 'rescrape_card_not_found' | 'ambiguous' | ... }
    async function verifyViaScheduleRescrape(actionLabel) {
      try {
        console.log(`[schedule-rescrape] ${actionLabel}: starting post-click verification...`);

        // 1. Close any modal that may still be open. Use BOTH a button-absence
        //    check (action buttons gone) AND a role=dialog detachment check.
        //    Empty-modal case: button-absence alone fires immediately even with
        //    the dialog still open, so we additionally wait for the dialog to
        //    detach (or time out, in which case we'll bail as ambiguous).
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForFunction(() => {
          const btns = [...document.querySelectorAll('button, [role="button"]')];
          return !btns.some(el => {
            const t = (el.textContent || '').toLowerCase().trim();
            return (t.includes('register') || t.includes('reserve') ||
                    t.includes('waitlist') || t === 'login to register') &&
                   el.getBoundingClientRect().width > 0;
          });
        }, { timeout: 1500 }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        // Explicitly wait for the dialog to disappear before rescraping.
        const dialogClosed = await page.waitForFunction(() => {
          const dlgs = [...document.querySelectorAll('[role="dialog"]')];
          return !dlgs.some(d => {
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        }, { timeout: 1500 }).then(() => true).catch(() => false);
        if (!dialogClosed) {
          console.log(`[schedule-rescrape] ${actionLabel}: dialog did not close after Escape — bailing as ambiguous to avoid reading stale modal state`);
          return { verified: null, reason: 'modal_did_not_close', buttons: [] };
        }
        await page.waitForTimeout(150);

        // 2. Defensive: if click navigated us away from the schedule embed,
        //    return ambiguous rather than rescraping a wrong page.
        if (!page.url().includes('schedulesembed')) {
          console.log(`[schedule-rescrape] ${actionLabel}: not on schedule embed (url=${page.url()}) — cannot rescrape`);
          return { verified: null, reason: 'not_on_schedule_page', buttons: [] };
        }

        // 3. Re-locate the same target card (markers from prior findTargetCard
        //    call were cleared after click; this performs a fresh content-based
        //    scan exactly the way the original location did).
        let recheckCard = null;
        try {
          recheckCard = await findTargetCard();
        } catch (e) {
          console.log(`[schedule-rescrape] ${actionLabel}: findTargetCard error — ${e.message}`);
          return { verified: null, reason: 'rescrape_card_lookup_error', buttons: [], error: e.message };
        }
        if (!recheckCard) {
          console.log(`[schedule-rescrape] ${actionLabel}: card no longer found on schedule (could mean removed, scrolled off, or page state changed)`);
          return { verified: null, reason: 'rescrape_card_not_found', buttons: [] };
        }

        // 4. Click to re-open modal — prefer interactive child, fall back to card itself
        try { await recheckCard.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch {}
        const innerClickable = recheckCard.locator("button, [role='button'], a").first();
        const clickTarget = (await innerClickable.count()) > 0 ? innerClickable : recheckCard;
        const reclickErr = await clickTarget.click({ timeout: 5000 }).then(() => null).catch((e) => e);
        if (reclickErr) {
          console.log(`[schedule-rescrape] ${actionLabel}: re-click error — ${reclickErr.message}`);
          return { verified: null, reason: 'rescrape_reclick_error', buttons: [], error: reclickErr.message };
        }

        // 5. Wait for the dialog to actually appear before reading anything.
        const dialogOpened = await page.waitForSelector('[role="dialog"]:visible', { timeout: 3000 })
          .then(() => true).catch(() => false);
        if (!dialogOpened) {
          console.log(`[schedule-rescrape] ${actionLabel}: re-opened dialog never appeared — ambiguous`);
          return { verified: null, reason: 'rescrape_dialog_did_not_open', buttons: [] };
        }
        await page.waitForSelector(ACTION_SELECTORS.modalReady, { timeout: 2000 }).catch(() => null);
        await page.waitForTimeout(300);

        // 6. CRITICAL: identity-verify the re-opened modal before trusting its
        //    button state. If findTargetCard re-selected a similar but different
        //    card (e.g. score tie shifted), the buttons we read could belong to
        //    an OTHER class that the user happens to be registered for —
        //    producing a false positive identical to the bug we're fixing.
        //    Same pattern as attemptClickAndVerify (~line 2247).
        const dialogScope = page.locator('[role="dialog"]:visible').first();
        const modalText = (await dialogScope.evaluate(el => (el.innerText || el.textContent || '')).catch(() => '')).toLowerCase();
        // Title MUST match — most discriminating signal. Time MUST match.
        // Instructor only checked when configured. Refuse to interpret on any mismatch.
        const idVerifyTitle = !!classTitle && modalText.includes(String(classTitle).toLowerCase());
        const idVerifyTime  = !!classTimeNorm && modalText.includes(String(classTimeNorm).toLowerCase());
        const idVerifyInst  = !instructorFirstName || modalText.includes(String(instructorFirstName).toLowerCase());
        if (!idVerifyTitle || !idVerifyTime || !idVerifyInst) {
          console.log(`[schedule-rescrape] ${actionLabel}: re-opened modal does NOT match target identity (title=${idVerifyTitle} time=${idVerifyTime} instructor=${idVerifyInst}) — refusing to interpret. Modal preview: "${modalText.slice(0, 120)}"`);
          await page.keyboard.press('Escape').catch(() => {});
          return { verified: null, reason: 'rescrape_identity_mismatch', buttons: [], modalPreview: modalText.slice(0, 200) };
        }

        // 7. Read button text SCOPED TO THE DIALOG — not page-wide. A page-wide
        //    read would pick up any "Cancel"/"Reserved" labels on background
        //    schedule rows, producing false positives.
        const btnTexts = await dialogScope
          .locator('button:visible, [role="button"]:visible')
          .allTextContents().catch(() => []);
        const cleaned = btnTexts.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);

        const hasConfirmedReservation = cleaned.some(t =>
          /view\s*reservation|view\s*waitlist|unregister|cancel\s*registration|leave\s*waitlist/i.test(t)
        );
        const hasOnlyRegister = !hasConfirmedReservation &&
          cleaned.some(t => /^register$|^reserve$|^waitlist$|^join\s*waitlist$/i.test(t));

        // 8. Close the modal we just opened
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(150);

        if (hasConfirmedReservation) {
          console.log(`[schedule-rescrape] ${actionLabel}: ✅ VERIFIED REGISTERED — dialog buttons: ${JSON.stringify(cleaned)}`);
          return { verified: true, reason: 'reservation_or_cancel_visible', buttons: cleaned };
        }
        if (hasOnlyRegister) {
          console.log(`[schedule-rescrape] ${actionLabel}: ❌ VERIFIED NOT REGISTERED — Register/Waitlist still in dialog: ${JSON.stringify(cleaned)}`);
          return { verified: false, reason: 'register_still_visible', buttons: cleaned };
        }
        console.log(`[schedule-rescrape] ${actionLabel}: ⚠️ AMBIGUOUS — no decisive button text in dialog: ${JSON.stringify(cleaned)}`);
        return { verified: null, reason: 'ambiguous', buttons: cleaned };
      } catch (e) {
        console.log(`[schedule-rescrape] ${actionLabel}: helper threw — ${e.message}`);
        return { verified: null, reason: 'rescrape_exception', buttons: [], error: e.message };
      }
    }
    // ────────────────────────────────────────────────────────────────────────────

    // ── Detail-page booking handler ────────────────────────────────────────────
    // Some FW class cards (e.g. Flow Yoga) respond to "Register" clicks by
    // NAVIGATING to a class detail page (URL pattern /m?p=schedules-class&class=…)
    // instead of opening an inline booking modal. The user must then click a
    // second Register button on the detail page to actually reserve.
    //
    // Called immediately after every Register/Waitlist click. If the URL has
    // navigated away from the schedule embed, this helper:
    //   1. Verifies we're on a FamilyWorks page (not navigated externally).
    //   2. Verifies identity (title + time + optional instructor in page text).
    //   3. Finds the real Register/Reserve button on the detail page.
    //   4. Clicks it and waits for a state change.
    //   5. Navigates back to the schedule embed so the existing
    //      verifyViaScheduleRescrape flow can authoritatively confirm.
    //
    // No-op when no navigation happened. Always tries to restore the schedule
    // embed before returning so the outer flow can keep working.
    //
    // Returns: { handled: bool, signal: 'success'|'already_registered'|'no_button'|'no_signal'|'identity_mismatch'|'error', reason: string }
    async function completeBookingOnDetailPageIfNavigated(actionLabel) {
      // Wait briefly for any navigation triggered by the click to settle.
      // (Task #60: tightened from 600 → 300 ms.  Bubble.io's SPA navigation
      // fires within ~150 ms in practice; 300 ms keeps a safety margin without
      // adding 300 ms to every successful in-modal flow.)
      await page.waitForTimeout(300);
      const currentUrl = page.url();

      // Not a detail-page navigation — modal-based flow continues normally
      if (currentUrl.includes('schedulesembed')) {
        return { handled: false };
      }
      if (!currentUrl.includes('familyworks.app')) {
        console.log(`[detail-page] ${actionLabel}: navigated OFF FamilyWorks (url=${currentUrl}) — restoring schedule and bailing`);
        await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 }).catch(() => {});
        return { handled: true, signal: 'error', reason: 'navigated_off_familyworks' };
      }

      console.log(`[detail-page] ${actionLabel}: detected navigation to ${currentUrl} — completing booking on detail page`);

      try {
        // 1. Wait for detail page to render (Bubble.io SPA needs a beat).
        // (Task #60: tightened from 1500 → 800 ms.  Detail page is mostly
        // server-side rendered; 800 ms is enough for Bubble's hydration.)
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(800);

        // 2. Identity check — refuse to interact with a page that isn't the right class
        const pageText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
        const idTitle = !!classTitle && pageText.includes(String(classTitle).toLowerCase());
        const idTime  = !!classTimeNorm && pageText.includes(String(classTimeNorm).toLowerCase());
        const idInst  = !instructorFirstName || pageText.includes(String(instructorFirstName).toLowerCase());
        if (!idTitle || !idTime || !idInst) {
          console.log(`[detail-page] ${actionLabel}: identity mismatch (title=${idTitle} time=${idTime} instructor=${idInst}) — refusing to click anything`);
          await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 }).catch(() => {});
          return { handled: true, signal: 'identity_mismatch', reason: 'detail_page_identity_mismatch' };
        }
        console.log(`[detail-page] ${actionLabel}: identity verified on detail page`);

        // 3. First check whether the original click ALREADY registered us —
        //    detail page may now show "Cancel Registration" / "View Reservation"
        const alreadyReservedNow = await page.locator(
          'button:visible:has-text("Cancel Registration"), button:visible:has-text("View Reservation"), ' +
          'button:visible:has-text("Unregister"), button:visible:has-text("Leave Waitlist"), ' +
          '[role="button"]:visible:has-text("Cancel Registration"), [role="button"]:visible:has-text("View Reservation")'
        ).count().catch(() => 0);
        if (alreadyReservedNow > 0) {
          console.log(`[detail-page] ${actionLabel}: detail page already shows Cancel/View Reservation — first click DID register the user`);
          await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 }).catch(() => {});
          return { handled: true, signal: 'already_registered', reason: 'first_click_registered' };
        }

        // 4. Find the real Register/Reserve button on the detail page.
        //    Exclude "Login to Register" so we don't false-match the auth gate.
        //    Use exact-text matching to avoid hitting unrelated text elements.
        const detailRegisterBtn = page.locator(
          'button:visible, [role="button"]:visible, a:visible'
        ).filter({
          hasText: /^(register|reserve|sign\s*up|join\s*waitlist|waitlist)$/i
        }).first();

        const btnCount = await detailRegisterBtn.count().catch(() => 0);
        if (btnCount === 0) {
          console.log(`[detail-page] ${actionLabel}: no Register/Reserve button found on detail page — restoring schedule`);
          await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 }).catch(() => {});
          return { handled: true, signal: 'no_button', reason: 'detail_page_no_register_button' };
        }

        const detailBtnText = (await detailRegisterBtn.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
        console.log(`[detail-page] ${actionLabel}: clicking detail-page button "${detailBtnText}"`);
        const clickErr = await detailRegisterBtn.click({ timeout: 5000 }).then(() => null).catch(e => e);
        if (clickErr) {
          console.log(`[detail-page] ${actionLabel}: detail-page click error — ${clickErr.message}`);
          await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 }).catch(() => {});
          return { handled: true, signal: 'error', reason: 'detail_page_click_error', error: clickErr.message };
        }

        // 5. Wait for some change — possible outcomes: button text flips,
        //    a confirmation modal opens, or the page navigates again.
        // (Task #60: tightened from 2000 → 1000 ms.  The button-state read
        //  immediately after is the actual decisive signal; settle wait only
        //  needs to outlast Bubble's render hop.)
        await page.waitForTimeout(1000);

        const postBtns = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(() => []);
        const cleanedPost = postBtns.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const successButton = cleanedPost.some(t =>
          /view\s*reservation|view\s*waitlist|unregister|cancel\s*registration|leave\s*waitlist/i.test(t)
        );
        const successText = /you.?re registered|reservation\s*confirmed|registered\s*successfully|booking\s*confirmed|you.?re\s*on\s*the\s*waitlist/i
          .test((await page.locator('body').innerText().catch(() => '')).toLowerCase());

        // 6. Always navigate back to schedule embed so the outer flow / rescrape
        //    can run its authoritative check. Even if we got a success signal,
        //    don't trust it alone — let the rescrape verify.
        await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 }).catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

        if (successButton || successText) {
          console.log(`[detail-page] ${actionLabel}: detail-page click produced success signal (button=${successButton}, text=${successText}) — back on schedule, rescrape will verify`);
          return { handled: true, signal: 'success', reason: 'detail_page_success_signal' };
        }
        console.log(`[detail-page] ${actionLabel}: detail-page click produced no decisive signal — back on schedule, rescrape will verify authoritatively`);
        return { handled: true, signal: 'no_signal', reason: 'detail_page_no_signal' };
      } catch (e) {
        console.log(`[detail-page] ${actionLabel}: helper threw — ${e.message}`);
        await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 }).catch(() => {});
        return { handled: true, signal: 'error', reason: 'detail_page_exception', error: e.message };
      }
    }
    // ────────────────────────────────────────────────────────────────────────────

    // Try the best candidate first; if post-click verification fails, attempt
    // the second-best candidate once (PART 6).
    // Rules: only try second-best once; never skip verification; fail safe.
    //
    // Status semantics for modal-verification failures:
    //   - Time mismatch → the 7:45 AM class is not on the schedule → not_found
    //     (we clicked something with the right title/instructor but wrong time,
    //     which definitively means our target slot hasn't appeared yet)
    //   - Instructor mismatch or unexpected exception → error
    //     (something unexpected happened that warrants investigation)
    // Stage 5: title and time-title mismatches are also "wrong modal opened"
    // outcomes — same containment path applies (try second-best, else bail safely).
    const isTimeMismatch = r => r.reasonTag === 'time' || r.reasonTag === 'time-instructor'
                             || r.reasonTag === 'title' || r.reasonTag === 'time-title';

    // Row-capacity signal from schedule row — guides behavior but does not
    // necessarily prevent clicking:
    //
    //   'full'    — class is at capacity in the row text.  In PREFLIGHT mode we
    //               fall through so the modal can be opened and the actual button
    //               state inspected (the modal may still show a Register button
    //               that joins the waitlist).  In BOOKING mode we also fall
    //               through — the booking loop at the bottom handles the
    //               "full → Register → waitlist" path already.
    //               Only bail if NO booking action is found after opening.
    //
    //   'waitlist' — row shows "Waitlist" label.  In PREFLIGHT we can shortcut
    //                (waitlist status is confirmed); in BOOKING we fall through
    //                so the bot actually clicks through and joins the waitlist.
    if (_rowCapacityFromSchedule === 'waitlist' && PREFLIGHT_ONLY) {
      console.log('[row-capacity] Preflight: schedule row shows waitlist — class full, waitlist available');
      return logRunSummary({
        status:   'waitlist_only',
        message:  'Class is full — waitlist shown on schedule row',
        screenshotPath,
        phase:    'action',
        reason:   'class_full',
        category: 'availability',
      });
    }
    if (_rowCapacityFromSchedule) {
      console.log(`[row-capacity] Row shows "${_rowCapacityFromSchedule}" — proceeding to click modal for full action detection`);
    }

    // ── Self-Healing / Safe Recovery Pass — Stage 6: filter-failure trust gate ──
    // pageHealth = filters_failed propagates here as the run-scoped flag
    // `filtersFailed` (set at L1664 when both Category & Instructor filters had
    // no effect AND the Stage-3 page-reset heal could not restore them).
    //
    // The unfiltered scan above is allowed for VISIBILITY (so the operator can
    // see what the schedule looked like and we can capture truthful diagnostics),
    // but it must NOT authorize a Register click without strong identity proof.
    // Strong identity here means: BOTH title and time matched on the row that
    // findTargetCard() picked — i.e. _lastBestReasons contains 'title+5' AND
    // 'time+5'. (Score >= 8 alone is insufficient: time+instructor without
    // title can score 8 on a wrong-class same-time same-instructor neighbor.)
    //
    // If strong identity is NOT present while filters failed, bail safely with
    // the truthful 'filter_apply_failed' classification — the modal-verification
    // gate (Stage 5) would catch most wrong-class cases anyway, but failing
    // here preserves diagnostics, avoids burning a Bubble.io modal-open cycle,
    // and prevents any future regression in the modal walk from leaking through.
    if (filtersFailed) {
      const _reasons = Array.isArray(_lastBestReasons) ? _lastBestReasons : [];
      const _hasTitleHit = _reasons.includes('title+5');
      const _hasTimeHit  = _reasons.includes('time+5');
      const _strongIdentity = _hasTitleHit && _hasTimeHit;
      if (!_strongIdentity) {
        const msg = `[stage-6/filter-trust-gate] Filters failed and the unfiltered-scan candidate did not produce strong identity proof (titleHit=${_hasTitleHit}, timeHit=${_hasTimeHit}, score=${_lastBestScore}, reasons=[${_reasons.join(',')}], matched="${(_lastBestText || '').slice(0, 80)}"). Refusing to click — booking requires title+time evidence when filters are not trustworthy.`;
        console.log(`❌ ${msg}`);
        await captureFailure('scan', 'filter_apply_failed');
        return logRunSummary({
          status:  'error',
          message: msg,
          screenshotPath,
          phase:   'scan',
          reason:  'filter_apply_failed',
          category: 'scan',
          label:   'Filter failure — candidate lacks strong identity proof',
          url:     page.url(),
        });
      }
      console.log(`🛡️  [stage-6/filter-trust-gate] Filters failed BUT candidate has strong identity (title+time matched on row, score=${_lastBestScore}) — allowing click; modal verification will provide final gate.`);
    }
    // ────────────────────────────────────────────────────────────────────────────

    _tc.modal_open_start = new Date().toISOString();
    const firstResult = await attemptClickAndVerify(targetCard, 'best candidate');

    if (!firstResult.ok) {
      // Decide whether to try the second-best fallback.
      // T003: if attemptClickAndVerify already promoted the second-best card
      // in-function (winner had no clickable child), do NOT retry it here —
      // doing so would double-attempt the same card and could misclassify the
      // outcome as "both candidates had the wrong time" when only one was tried.
      const alreadyPromotedSecond = firstResult.usedSecondBest === true;
      const secondQualifies = !alreadyPromotedSecond && _lastSecondCard && _lastSecondScore >= CONFIDENCE_THRESHOLD - 2;
      if (alreadyPromotedSecond) {
        console.log(`ℹ️  Skipping outer second-best retry — second-best was already promoted inside the first attempt.`);
      }

      if (secondQualifies) {
        console.log(`⚠️ Best match failed verification, trying second-best candidate once`);
        console.log(`   Best score: ${_lastBestScore} | Selected row: "${_lastBestText.slice(0, 100)}"`);
        console.log(`   Second-best score: ${_lastSecondScore} | Row: "${_lastSecondText.slice(0, 100)}"`);

        // Dismiss the current modal before clicking a different card.
        // Signal-driven: resolve as soon as modal action buttons disappear from
        // the page (cap 1500 ms).  Saves up to ~900 ms vs the old flat 1200 ms
        // when Bubble.io's CSS dismiss animation completes in 200-400 ms.
        // FamilyWorks's schedule list does not show Register/Reserve/Waitlist
        // buttons on the card rows themselves, so absence of these buttons is a
        // reliable indicator that the modal is fully closed.
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForFunction(() => {
          const btns = [...document.querySelectorAll('button, [role="button"]')];
          return !btns.some(el => {
            const t = (el.textContent || '').toLowerCase().trim();
            return (t.includes('register') || t.includes('reserve') ||
                    t.includes('waitlist') || t === 'login to register') &&
                   el.getBoundingClientRect().width > 0;
          });
        }, { timeout: 1500 }).catch(() => {});

        const secondResult = await attemptClickAndVerify(_lastSecondCard, 'second-best candidate');
        if (!secondResult.ok) {
          // Stage 8: split modal-mismatch outcomes by their semantic meaning.
          //   - WRONG TIME (incl. time-instructor, time-title): the modal opened
          //     at a different time slot in BOTH attempts → the target time slot
          //     does not appear on the schedule → 'class_not_found' is truthful.
          //   - WRONG TITLE only (right time, wrong class name): we picked the
          //     wrong row(s); the target class MAY exist at the correct time
          //     but we couldn't reliably target it → emit the new
          //     'wrong_modal_unverified' reason so this is not collapsed into
          //     "class is absent". Diagnostics, screenshot, and run summary
          //     are preserved with operator-readable wording.
          if (_isTitleOnlyMismatch(secondResult.reasonTag) || _isTitleOnlyMismatch(firstResult.reasonTag)) {
            const msg = _wcPrefix + `Wrong-class modal opened in both attempts (right time, wrong class name) — picked rows did not match "${classTitle}". Target may still exist at ${classTimeNorm} but could not be reliably identified.`;
            console.log(`ℹ️  [stage-8/wrong_modal_unverified] ${msg}`);
            await captureFailure('verify', 'wrong_modal_unverified');
            return logRunSummary({
              status:  'error',
              message: msg,
              screenshotPath,
              phase:   'verify',
              reason:  'wrong_modal_unverified',
              category:'verify',
              label:   'Wrong class modal opened — target not reliably identified',
              url:     page.url(),
            });
          }
          if (isTimeMismatch(secondResult)) {
            const msg = _wcPrefix + `Class rows were found but the booking modal showed a different class in all cases — both candidates had the wrong time. "${classTitle}" at ${classTimeNorm} does not appear to be on the schedule yet.`;
            console.log(`ℹ️  ${msg}`);
            await captureFailure('scan', 'class_not_found');
            if (filtersFailed) {
              const filterMsg = `Could not verify class presence — schedule filters failed; unfiltered scan found rows but modal showed wrong class (both candidates). Class may exist at correct time but was not reliably targeted. Original: ${msg}`;
              return logRunSummary({ status: 'error', message: filterMsg, screenshotPath, phase: 'scan', reason: 'filter_apply_failed', category: 'scan', label: 'Could not verify class — filters failed (both candidates wrong)', url: page.url() });
            }
            return logRunSummary({ status: 'not_found', message: msg, screenshotPath, phase: 'scan', reason: 'class_not_found', category: 'scan', label: 'Class rows found but modal showed wrong class (all candidates)', url: page.url() });
          }
          // Verify failure already recorded inline in attemptClickAndVerify
          return logRunSummary({ status: 'error', message: secondResult.failMsg, screenshotPath, phase: 'verify', reason: REASONTAG_TO_REASON[secondResult.reasonTag] || 'unexpected_error', recorded: secondResult.recorded });
        }
        // Second-best passed verification — fall through to the booking step
      } else {
        if (_lastSecondCard) {
          console.log(`   Second-best exists (score ${_lastSecondScore}) but is below fallback floor (${CONFIDENCE_THRESHOLD - 2}) — not trying.`);
        } else {
          console.log('   No second-best candidate available.');
        }
        // Stage 8: same split as the two-attempt branch above. A title-only
        // mismatch with no fallback means our best guess was wrong — the
        // target may still exist at the correct time. Emit the new
        // 'wrong_modal_unverified' reason instead of class_not_found.
        if (_isTitleOnlyMismatch(firstResult.reasonTag)) {
          const msg = _wcPrefix + `Wrong-class modal opened (right time, wrong class name) — best matching row did not match "${classTitle}" and no second-best fallback was available. Target may still exist at ${classTimeNorm} but could not be reliably identified.`;
          console.log(`ℹ️  [stage-8/wrong_modal_unverified] ${msg}`);
          await captureFailure('verify', 'wrong_modal_unverified');
          return logRunSummary({
            status:  'error',
            message: msg,
            screenshotPath,
            phase:   'verify',
            reason:  'wrong_modal_unverified',
            category:'verify',
            label:   'Wrong class modal opened — target not reliably identified',
            url:     page.url(),
          });
        }
        // Time mismatch with no fallback → target class absent from schedule
        if (isTimeMismatch(firstResult)) {
          const msg = _wcPrefix + `A class row was found but the booking modal showed a different class — the best matching row had the wrong time. "${classTitle}" at ${classTimeNorm} does not appear to be on the schedule yet.`;
          console.log(`ℹ️  ${msg}`);
          await captureFailure('scan', 'class_not_found');
          if (filtersFailed) {
            const filterMsg = `Could not verify class presence — schedule filters failed; unfiltered scan found a row but modal showed wrong class (best candidate). Class may exist at correct time but was not reliably targeted. Original: ${msg}`;
            return logRunSummary({ status: 'error', message: filterMsg, screenshotPath, phase: 'scan', reason: 'filter_apply_failed', category: 'scan', label: 'Could not verify class — filters failed (best candidate wrong)', url: page.url() });
          }
          return logRunSummary({ status: 'not_found', message: msg, screenshotPath, phase: 'scan', reason: 'class_not_found', category: 'scan', label: 'Class row found but modal showed wrong class (best candidate)', url: page.url() });
        }
        // Verify failure already recorded inline in attemptClickAndVerify
        return logRunSummary({ status: 'error', message: firstResult.failMsg, screenshotPath, phase: 'verify', reason: REASONTAG_TO_REASON[firstResult.reasonTag] || 'unexpected_error', recorded: firstResult.recorded });
      }
    }

    // ── Booking-path modal-reached record ─────────────────────────────────────
    // Mirrors the preflight gate (line ~2297) so that later action failures do
    // not lose the fact that the modal was successfully opened and identity-
    // verified.  Runs whether the first OR second-best candidate produced ok:true
    // — both paths fall through to this point.
    _state.bundle.modal = 'MODAL_READY';
    emitEvent(_state, 'MODAL', null, 'Modal opened and verified (booking)', {
      evidence: {
        modalPreview: _lastModalPreview || '(preview not captured)',
        url:          page.url(),
      }
    });
    // ──────────────────────────────────────────────────────────────────────────

    // Step 5: Try to register — retry every 30s for up to 10 minutes if not open yet.
    // maxAttemptsOpt can be passed in job object (e.g. 1 for web UI, 20 for cron).
    advance(_state, 'ACTION');
    const maxAttempts = maxAttemptsOpt || 20;
    let registered = false;
    // Stage 10E — sticky structured outcome of the most recent post-click
    // confirmation. Populated by confirmBookingOutcome() at each Register/
    // Waitlist click site and surfaced on the run result + sniper-state.
    let _lastConfirmation = { finalOutcome: null, confirmationSignals: null };

    // ── PREFLIGHT GATE ─────────────────────────────────────────────────────────
    // When preflightOnly is set, check readiness of the booking action without
    // actually clicking Register/Waitlist.  Returns immediately after sniffing
    // which buttons are present in the already-open modal.
    if (PREFLIGHT_ONLY) {
      const { hasRegister, hasWaitlist, hasLoginRequired: hasLoginBtn, registerBtn, waitlistBtn, allBtnTexts, registerStrategy, waitlistStrategy } = await detectActionButtons(page, await _getModalScope(page));
      console.log('[preflight] Visible buttons:', JSON.stringify(allBtnTexts));

      // ── Stage 1: Action-state classification ────────────────────────────────
      // Fetch page body text once so the classifier can check both button signals
      // and broader page-level signals (0 spots left, Registration Unavailable, etc.)
      const _pageBodyText = await page.locator('body').innerText().catch(() => '');
      const _actionStateClassified = classifyActionState(allBtnTexts, _pageBodyText);
      console.log('[preflight] Action state classified:', _actionStateClassified,
        '| buttons:', JSON.stringify(allBtnTexts));

      // ── Stage 8: Modal Reachability Check ─────────────────────────────────
      // We reached this gate via a successful attemptClickAndVerify(), which
      // confirmed the modal opened and showed the expected time + instructor.
      // Mark modal as reachable and record evidence for Tools before inspecting
      // which booking buttons are present.
      _state.bundle.modal = 'MODAL_READY';
      emitEvent(_state, 'MODAL', null, 'Preflight: modal opened and verified', {
        evidence: {
          buttonsVisible: allBtnTexts,
          modalPreview:   _lastModalPreview || '(preview not captured)',
          url:            page.url(),
        }
      });
      // ──────────────────────────────────────────────────────────────────────

      // ── Stage 9: Action Detection Check ───────────────────────────────────
      // Classify what booking action (if any) is available in the open modal,
      // and record the result as evidence for Tools — without clicking anything.
      const _hasCancelOnly = allBtnTexts.some(t => /\bcancel\b/i.test(t))
        && !hasRegister && !hasWaitlist && !hasLoginBtn;
      const _actionState = hasLoginBtn    ? 'LOGIN_REQUIRED'
        : hasRegister
            ? (allBtnTexts.some(t => /\breserve\b/i.test(t)) ? 'RESERVE_AVAILABLE' : 'REGISTER_AVAILABLE')
        : hasWaitlist   ? 'WAITLIST_AVAILABLE'
        : _hasCancelOnly ? 'CANCEL_ONLY'
        : _actionStateClassified === 'not_open_yet' ? 'NOT_OPEN_YET'
        : 'UNKNOWN_ACTION';
      emitEvent(_state, 'ACTION', null, `Preflight: detected action state — ${_actionState} (classified: ${_actionStateClassified})`, {
        evidence: {
          actionState:           _actionState,
          actionStateClassified: _actionStateClassified,   // Stage 1: richer classification
          buttonsVisible:        allBtnTexts,
          registerStrategy,
          waitlistStrategy,
        }
      });
      console.log('[preflight] Action state:', _actionState, '| classified:', _actionStateClassified);

      // ── Stage 2: Booking access confirmed ─────────────────────────────────
      // The modal opened successfully (proved by attemptClickAndVerify above).
      // bookingAccessConfirmed = true when the modal is reachable without re-login
      // — even if registration isn't open yet (UNKNOWN_ACTION / countdown).
      // LOGIN_REQUIRED is the only state that means we cannot access the booking
      // surface with the current session.
      const _modalAccessible = _actionState !== 'LOGIN_REQUIRED';
      updateAuthState({
        bookingAccessConfirmed:   _modalAccessible,
        bookingAccessConfirmedAt: _modalAccessible ? Date.now() : null,
        ...(_modalAccessible
          ? { familyworksValid: true, daxkoValid: true }
          : { familyworksValid: false }),
        lastCheckedAt: Date.now(),
      });
      console.log(`[booking-access] bookingAccessConfirmed=${_modalAccessible} (action=${_actionState})`);

      // Persist fresh browser cookies so the next run's Stage-1 injection
      // uses the session that was just confirmed working.
      if (_modalAccessible) {
        try {
          const freshCookies = await page.context().cookies();
          if (freshCookies.length > 0) {
            saveCookies(freshCookies);
            console.log(`[booking-access] Saved ${freshCookies.length} fresh cookies after booking surface confirmation.`);
          }
        } catch (e) {
          console.warn('[booking-access] Cookie save failed:', e.message);
        }
      }
      // ──────────────────────────────────────────────────────────────────────

      if (hasLoginBtn) {
        const inlineAuth = await attemptInlineAuth(page);
        console.log('[preflight] inline-auth result:', inlineAuth.detail);
        if (inlineAuth.authenticated) {
          await page.waitForTimeout(1000);
          const recheck = await detectActionButtons(page);
          if (!recheck.hasLoginRequired) {
            if (recheck.hasRegister) {
              _state.bundle.action = 'ACTION_READY';
              _state.sniperState   = 'SNIPER_READY';
              emitEvent(_state, 'ACTION', null, 'Preflight: Register button visible after inline auth');
              _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'FamilyWorks session active — Register button visible after inline auth' });
              // Inline auth recovered the session — update all three truths.
              updateAuthState({ bookingAccessConfirmed: true, bookingAccessConfirmedAt: Date.now(), familyworksValid: true, daxkoValid: true, lastCheckedAt: Date.now() });
              try { const c = await page.context().cookies(); if (c.length) saveCookies(c); } catch {}
              await snap('preflight-pass-after-auth');
              return logRunSummary({ status: 'success', message: 'Preflight passed after inline auth — Register button available', screenshotPath });
            }
            if (recheck.hasWaitlist) {
              _state.bundle.action = 'ACTION_READY';
              emitEvent(_state, 'ACTION', 'WAITLIST_ONLY', 'Preflight: Waitlist only after inline auth');
              _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'FamilyWorks session active — Waitlist button visible after inline auth' });
              // Inline auth recovered the session — update all three truths.
              updateAuthState({ bookingAccessConfirmed: true, bookingAccessConfirmedAt: Date.now(), familyworksValid: true, daxkoValid: true, lastCheckedAt: Date.now() });
              try { const c = await page.context().cookies(); if (c.length) saveCookies(c); } catch {}
              await snap('preflight-waitlist-after-auth');
              return logRunSummary({ status: 'waitlist_only', message: 'Preflight: class is full — only Waitlist available', screenshotPath });
            }
          }
        }
        // Capture screenshot BEFORE emitting event so the filename is available
        // as evidence in the Tools timeline (e.g. "preflight-auth-fail-<ts>.png").
        await captureFailure('auth', 'session_expired');
        emitFailure('MODAL', 'MODAL_LOGIN_REQUIRED', 'Preflight: session expired — modal shows Login to Register');
        _saveFwStatus({ ready: false, status: 'FAMILYWORKS_SESSION_MISSING', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'Preflight: Login to Register shown in modal — FamilyWorks session missing' });
        return logRunSummary({ status: 'error', message: 'Preflight: session expired in modal — Login to Register shown', screenshotPath, phase: 'auth', reason: 'session_expired', category: 'auth', label: 'Preflight: session expired in modal', url: page.url() });

      // ── Stage 2: Full / Closed detection ────────────────────────────────────
      // These two branches run BEFORE hasRegister / hasWaitlist so that strong
      // full/closed signals always win — even in the (unlikely) edge case where
      // both a "Register" button and a "Closed - Full" indicator are present.
      } else if (_actionStateClassified === 'full') {
        // Class is full — but check if a booking action is still available.
        // On FamilyWorks web, clicking "Register" on a full class joins the waitlist
        // (same button, different outcome).  If the DOM shows any booking button,
        // hand off to a booking run so it can join the waitlist.
        if (hasRegister || hasWaitlist) {
          _state.bundle.action = 'ACTION_READY';
          emitEvent(_state, 'ACTION', 'WAITLIST_ONLY', 'Preflight: class full — Register/Waitlist button visible (will join waitlist on booking run)');
          _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'FamilyWorks: class full — booking button visible (booking run will join waitlist)' });
          await snap('preflight-full-waitlist');
          return logRunSummary({ status: 'waitlist_only', message: 'Preflight: class full — Register/Waitlist button visible (booking run will join waitlist)', screenshotPath });
        }
        _state.bundle.action = 'ACTION_BLOCKED';
        _saveFwStatus({ ready: false, status: 'CLASS_FULL', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'Class is full — 0 spots available' });
        await snap('preflight-full');
        return logRunSummary({ status: 'full', message: 'Class is full — no spots available', screenshotPath, phase: 'action', reason: 'class_full', category: 'availability', label: 'Class full' });
      } else if (_actionStateClassified === 'closed') {
        _state.bundle.action = 'ACTION_BLOCKED';
        _saveFwStatus({ ready: false, status: 'CLASS_CLOSED', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'Registration is closed' });
        await snap('preflight-closed');
        return logRunSummary({ status: 'closed', message: 'Registration is closed', screenshotPath, phase: 'action', reason: 'registration_closed', category: 'availability', label: 'Registration closed' });
      // ────────────────────────────────────────────────────────────────────────

      // ── Stage 3: Classifier-first gate ──────────────────────────────────────
      // The classifier is now the primary authority.  DOM signals (hasRegister /
      // hasWaitlist) are used as a safe fallback only when the classifier returns
      // 'unknown' — preventing mismatches where a stale DOM element disagrees with
      // the visible page text.
      } else if (_actionStateClassified === 'bookable'
               || (_actionStateClassified === 'unknown' && hasRegister)) {
        _state.bundle.action = 'ACTION_READY';
        _state.sniperState   = 'SNIPER_READY';
        emitEvent(_state, 'ACTION', null, 'Preflight: Register button visible — action ready');
        _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'FamilyWorks session active — Register button visible' });
        await snap('preflight-pass');
        return logRunSummary({ status: 'success', message: 'Preflight passed — Register button available and ready', screenshotPath });
      } else if (_actionStateClassified === 'waitlist_available'
               || (_actionStateClassified === 'unknown' && hasWaitlist)) {
        _state.bundle.action = 'ACTION_READY';
        emitEvent(_state, 'ACTION', 'WAITLIST_ONLY', 'Preflight: only Waitlist button visible — class is full');
        _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'FamilyWorks session active — Waitlist button visible (class full)' });
        await snap('preflight-waitlist');
        return logRunSummary({ status: 'waitlist_only', message: 'Preflight: class is full — only Waitlist available', screenshotPath });
      } else {
        if (_actionStateClassified === 'already_registered' || _hasCancelOnly) {
          // Cancel/Unregister button visible with no Register/Waitlist — user is already enrolled.
          // This is a fully successful preflight state, not a failure.
          _state.bundle.action = 'ACTION_READY';
          _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'preflight', detail: 'FamilyWorks session active — Cancel button visible (already registered)' });
          await snap('preflight-already-registered');
          return logRunSummary({ status: 'success', message: 'Preflight: already registered — Cancel button visible in modal', screenshotPath });
        } else {
          // No booking button visible — registration window not open yet (e.g. countdown shown).
          // The modal IS reachable and the session IS valid — this is a healthy ready state.
          // Extract any countdown hint from the modal text to surface in the message.
          const _modalBodyRaw = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
          const _countdownMatch = _modalBodyRaw.match(/(\d+\s*(?:hr|hour|min|minute)s?\s*until\s*(?:open\s*)?registration)/i);
          const _countdownHint = _countdownMatch ? _countdownMatch[1].trim() : '';
          const _notOpenMsg = _countdownHint
            ? `Session ready — registration opens in ${_countdownHint.replace(/\s*until\s*(open\s*)?registration/i, '').trim()}`
            : 'Session ready — registration not open yet';
          _state.bundle.action = 'ACTION_BLOCKED';
          _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'preflight', detail: `FamilyWorks session active — modal accessible, registration not open yet${_countdownHint}` });
          await snap('preflight-not-open-yet');
          return logRunSummary({ status: 'found_not_open_yet', reason: 'button_not_visible', message: _notOpenMsg, screenshotPath });
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Task #60 retry cap: when verifyViaScheduleRescrape returns
    // `not_on_schedule_page` repeatedly, the click reliably navigated us off
    // the schedule embed (detail-page flow) and rescrape can never succeed.
    // After 2 such consecutive outcomes, bail out instead of burning the full
    // 20-attempt loop on a known-bad path.  Reset on any other rescrape result.
    let _consecNotOnSchedulePage = 0;
    const NOT_ON_SCHEDULE_RETRY_CAP = 2;

    // Task #60 — lifecycle helper for the post-click confirming sub-phase.
    // Persists the cleared state so the readiness API never reports a stale
    // confirmingPhase across iteration boundaries (continue / break / return).
    const _endConfirming = () => {
      try {
        if (_state.isConfirming || _state.confirmingPhase) {
          _state.isConfirming = false;
          _state.confirmingPhase = null;
          saveState(_state);
        }
      } catch (_) { /* non-fatal — state file write failure is just stale UI */ }
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Wipe any stale confirming state from a previous iteration so the
      // (typically 3 s) inter-attempt waits do not leave the UI showing
      // "Re-checking schedule…" while the bot is actually idle.
      _endConfirming();
      if (attempt === 1) _tc.first_click_attempt_start = new Date().toISOString();
      if (attempt === 2 && !_tc.first_click_attempt_done) _tc.first_click_attempt_done = new Date().toISOString();
      _tc.action_attempt_start = new Date().toISOString();
      // Stage 3: scope button detection to the open modal ([role="dialog"]) where
      // possible — avoids full-page scans across nav, schedule rows, etc.
      // Falls back to page-wide automatically if no dialog element is found.
      const _attemptModalScope = await _getModalScope(page);
      let { hasRegister, hasWaitlist, hasCancel: hasCancelNow, hasLoginRequired: hasLoginButton,
            registerBtn, waitlistBtn, cancelBtn, allBtnTexts: allBtns,
            registerStrategy, waitlistStrategy } = await detectActionButtons(page, _attemptModalScope);

      // Stage 4: Local recovery for half-rendered modal states.
      // If the modal dialog is confirmed open (scope found) but no action buttons
      // rendered yet, do a short bounded retry before escalating to the full
      // 5s wait + page reload cycle.  Cap: 3 × 150ms = 450ms max.
      // Fires at any attempt — Bubble.io can briefly detach buttons after re-open.
      if (_attemptModalScope && !hasRegister && !hasWaitlist && !hasCancelNow && !hasLoginButton) {
        console.log(`[half-render] attempt ${attempt}: dialog open but no buttons yet — local recovery (3 × 150ms)`);
        for (let _r = 0; _r < 3; _r++) {
          await page.waitForTimeout(150);
          const _retry = await detectActionButtons(page, _attemptModalScope);
          if (_retry.hasRegister || _retry.hasWaitlist || _retry.hasCancel || _retry.hasLoginRequired) {
            console.log(`[half-render] Recovered after ${_r + 1} retry — buttons now visible`);
            hasRegister    = _retry.hasRegister;
            hasWaitlist    = _retry.hasWaitlist;
            hasCancelNow   = _retry.hasCancel;
            hasLoginButton = _retry.hasLoginRequired;
            if (_retry.registerBtn)      registerBtn      = _retry.registerBtn;
            if (_retry.waitlistBtn)      waitlistBtn      = _retry.waitlistBtn;
            if (_retry.allBtnTexts)      allBtns          = _retry.allBtnTexts;
            if (_retry.registerStrategy) registerStrategy = _retry.registerStrategy;
            if (_retry.waitlistStrategy) waitlistStrategy = _retry.waitlistStrategy;
            break;
          }
        }
      }

      // ── Post-recovery modal-action-missing diagnostic ──────────────────────
      // Fires only when: the dialog is confirmed open (_attemptModalScope set)
      // AND the initial detectActionButtons found no buttons AND the 3-retry
      // recovery loop also found no buttons.  Records what the modal actually
      // contains so failures can be distinguished:
      //   countdown_visible   — registration opens at a specific time (countdown shown)
      //   modal_nearly_empty  — dialog barely rendered (Bubble.io half-render)
      //   action_not_visible  — modal has content but no booking buttons yet
      if (_attemptModalScope && !hasRegister && !hasWaitlist && !hasCancelNow && !hasLoginButton) {
        const _dialogPreview = await _attemptModalScope.evaluate(el =>
          (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        ).catch(() => '');
        const _diagLabel = /\d+\s*(?:hr|hour|min|minute|sec)/i.test(_dialogPreview)
          ? 'countdown_visible'
          : _dialogPreview.length < 20
            ? 'modal_nearly_empty'
            : 'action_not_visible';
        console.log(`[modal-action-missing] attempt ${attempt}: modal open (${_diagLabel}) — no action buttons after recovery. Preview: "${_dialogPreview.slice(0, 100)}"`);
        emitEvent(_state, 'ACTION', 'ACTION_BLOCKED',
          `Modal open but no action buttons after recovery (${_diagLabel})`,
          {
            evidence: {
              attempt,
              diagLabel:    _diagLabel,
              modalPreview: _dialogPreview.slice(0, 200),
              buttonsVisible: allBtns,
            }
          }
        );

        // NOTE (Apr 2026): A "positive-inference" branch was tried here that
        // treated empty retry modals after a prior Register click as proof of
        // success. It produced false positives — the bot reported "Registered"
        // for runs where FamilyWorks had no actual reservation. Removed.
        // The empty-modal case must continue to fail closed; verifying real
        // enrollment requires re-scraping the user's schedule, not inference.
      }
      // ──────────────────────────────────────────────────────────────────────

      // Stage 2 marker: record the first time buttons become truly available.
      // Placed after Stage 4 recovery so that recovery time is included in the
      // measured gap (modal_to_action_ready_ms = modal_ready_at → action_ready_at).
      if (attempt === 1 && !_tc.action_ready_at &&
          (hasRegister || hasWaitlist || hasCancelNow || hasLoginButton)) {
        _tc.action_ready_at = new Date().toISOString();
      }

      console.log('Attempt ' + attempt + ': visible buttons: ' + JSON.stringify(allBtns));

      // If a Cancel button is visible at the START of an attempt (not Register/Waitlist),
      // AND we previously attempted a click (_replayAction is set), the booking/waitlist-join
      // already completed — the modal closed before we could detect it.
      // Guard on _replayAction to avoid false positives from Cancel buttons on OTHER
      // enrolled classes visible in the schedule background.
      if (_replayAction && hasCancelNow && !hasRegister && !hasWaitlist && !hasLoginButton) {
        console.log(`✅ Cancel button found at attempt ${attempt} start (prior action: ${_replayAction}) — enrollment already completed.`);
        replayStore.addEvent(_jobId, 'confirm', `Enrollment confirmed via Cancel at attempt-start (attempt ${attempt}, action: ${_replayAction})`);
        registered = true;
        break;
      }

      if (hasLoginButton) {
        const inlineAuth = await attemptInlineAuth(page);
        console.log('[inline-auth] result:', inlineAuth.detail);
        if (inlineAuth.authenticated) {
          await page.waitForTimeout(1500);
          const recheck = await detectActionButtons(page, await _getModalScope(page));
          hasRegister      = recheck.hasRegister;
          hasWaitlist      = recheck.hasWaitlist;
          hasLoginButton   = recheck.hasLoginRequired;
          if (recheck.registerBtn)  registerBtn      = recheck.registerBtn;
          if (recheck.waitlistBtn)  waitlistBtn      = recheck.waitlistBtn;
          if (recheck.allBtnTexts)  allBtns          = recheck.allBtnTexts;
          if (recheck.registerStrategy) registerStrategy = recheck.registerStrategy;
          if (recheck.waitlistStrategy) waitlistStrategy = recheck.waitlistStrategy;
          console.log('[inline-auth] re-check buttons:', JSON.stringify(allBtns));
        }
        if (hasLoginButton) {
          console.log('Session not authenticated — page shows "Login to Register". Failing fast.');
          await captureFailure('auth', 'session_expired');
          emitFailure('MODAL', 'MODAL_LOGIN_REQUIRED', 'Session expired inside booking modal');
          _saveFwStatus({ ready: false, status: 'FAMILYWORKS_SESSION_MISSING', checkedAt: new Date().toISOString(), source: 'booking', detail: 'Login to Register shown in booking modal — FamilyWorks session missing' });
          return logRunSummary({ status: 'error', message: 'Authentication/session failed: page shows "Login to Register"', screenshotPath, phase: 'auth', reason: 'session_expired', category: 'auth', label: 'Session expired inside booking modal', url: page.url() });
        }
      }

      if (hasRegister) {
        if (DRY_RUN) {
          console.log('DRY RUN: Would click Register button. Done.');
          registered = true;
          break;
        }
        // ── Full-class detection ───────────────────────────────────────────
        // On Bubble.io/FamilyWorks web, a class that is full still shows a
        // "Register" button (no separate Waitlist button), but clicking it
        // joins the waitlist rather than registering.  The mobile YMCA app
        // correctly labels this as "Waitlist".  Detect by checking the modal
        // body for "0 sp" (0 spots) or "full" before clicking, and treat the
        // action as a waitlist join so the status is reported accurately.
        const _modalBodyForSpots = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
        const _classIsFullModal  = /\b0\s*sp(ot)?s?\b|\bfull\b|\b0\/\d+\b/.test(_modalBodyForSpots);
        if (_classIsFullModal) {
          console.log(`⚠️ Class appears full (0 spots detected in modal) — Register button will join the waitlist.`);
          _replayAction = 'waitlist';
          replayStore.addEvent(_jobId, 'action_attempt', 'Clicked Register (class full → waitlist)', `Attempt ${attempt}`);
          _tc.actionClickAt = new Date().toISOString();
          // Stage 3: capture pre-click snapshot for already_waitlisted /
          // no_state_change detection in confirmBookingOutcome.
          const _preClickSnap_fw = await capturePreClickSnapshot(page, _attemptModalScope);
          await registerBtn.first().click();
          // Task #99 — FW waitlist flow has a 2-step confirmation: after the
          // first click, a small popup appears with the user's name and a
          // "Reserve" + "Close" button pair. Click Reserve so the waitlist
          // join is actually committed before the Stage 10E classifier reads
          // the post-click DOM. No-op when the popup never appears.
          const _reservePopup_fw = await clickWaitlistReserveConfirmation(
            page, undefined, { jobId: job.id || job.jobId || null },
          );
          if (_reservePopup_fw.popupSeen) {
            const _posSuffix_fw = _reservePopup_fw.waitlistPosition != null
              ? ` (position #${_reservePopup_fw.waitlistPosition})`
              : '';
            replayStore.addEvent(_jobId, 'action_attempt',
              _reservePopup_fw.clicked
                ? `Clicked Reserve confirmation popup (waitlist 2-step)${_posSuffix_fw}`
                : `Reserve confirmation popup detected but click failed: ${_reservePopup_fw.error || 'unknown'}`,
              `Attempt ${attempt}`);
          }
          // ── Stage 10E POINT 6 (full→waitlist) — strong post-click confirmation ──
          _state.isConfirming    = true;
          _state.confirmingPhase = attempt > 1
            ? `Retry ${attempt} of ${maxAttempts} · confirming…`
            : 'Confirming booking outcome…';
          saveState(_state);
          _tc.confirmation_check_start = new Date().toISOString();
          _lastConfirmation = await confirmBookingOutcome(page, 'waitlist', _attemptModalScope, _preClickSnap_fw);
          _tc.confirmation_check_done = new Date().toISOString();
          _state.isConfirming    = false;
          _state.confirmingPhase = null;
          // Task #101: enrich confirmationSignals with the post-Reserve
          // popup state so failure context + run summaries carry it.
          if (_lastConfirmation.confirmationSignals && typeof _lastConfirmation.confirmationSignals === 'object') {
            _lastConfirmation.confirmationSignals.popupConfirmedState = _reservePopup_fw.confirmedState ?? null;
            _lastConfirmation.confirmationSignals.waitlistPosition    = _reservePopup_fw.waitlistPosition ?? null;
          }
          console.log(`[stage-10e] Register(full→waitlist): finalOutcome=${_lastConfirmation.finalOutcome} signals=${JSON.stringify(_lastConfirmation.confirmationSignals)}`);
          // Stage 3 success outcomes: booked, waitlisted, waitlist_joined, already_waitlisted
          if (_lastConfirmation.finalOutcome === 'booked' ||
              _lastConfirmation.finalOutcome === 'waitlisted' ||
              _lastConfirmation.finalOutcome === 'waitlist_joined' ||
              _lastConfirmation.finalOutcome === 'already_waitlisted') {
            // Task #101: persist position so /api/state can surface it.
            // Always write — when the badge wasn't captured this run, clear
            // any cached position so the UI doesn't show a stale "#N" from
            // a prior run on the same job.
            const _pos_fw = _reservePopup_fw.waitlistPosition ?? null;
            try {
              const _jid = job.id || job.jobId || null;
              if (_pos_fw != null) waitlistPositionStore.set(_jid, _pos_fw);
              else                 waitlistPositionStore.clear(_jid);
            } catch (_) {}
            const _label_fw_ok = _waitlistLabel(_lastConfirmation.finalOutcome, _pos_fw);
            replayStore.addEvent(_jobId, 'confirm', `${_label_fw_ok} (Stage 10E outcome=${_lastConfirmation.finalOutcome})`);
            console.log(`WAITLIST: ${_label_fw_ok} for ${classTitle} ${classTimeNorm || classTime} (outcome=${_lastConfirmation.finalOutcome})`);
            registered = true;
            break;
          }
          // no_state_change / ambiguous / auth_interrupted → structured failure
          {
            await captureFailure('post_click', 'unconfirmed');
            // Stage 3 reason mapping (replaces still_open/ambiguous-only mapping)
            const _reason =
              _lastConfirmation.finalOutcome === 'auth_interrupted' ? 'auth_redirect_during_action' :
              _lastConfirmation.finalOutcome === 'no_state_change'  ? 'click_no_op_verified' :
                                                                       'registration_unclear';
            // Stage 4: truthful operator-facing label & message keyed on outcome
            // Task #101: include the position when the helper saw it (rare on
            // failure paths, but harmless when null).
            const _pos_fw_fail = _reservePopup_fw.waitlistPosition ?? null;
            const _label_fw   = _waitlistLabel(_lastConfirmation.finalOutcome, _pos_fw_fail);
            const _message_fw = _waitlistMessage(_lastConfirmation.finalOutcome, _pos_fw_fail);
            recordFailure({
              jobId:    job.id || job.jobId || null,
              phase:    'post_click', reason: _reason,
              category: 'post_click',
              label:    _label_fw,
              message:  _message_fw,
              classTitle,
              screenshot: _screenshotRef(screenshotPath),
              url:      page.url(),
              context:  {
                attempt,
                finalOutcome:        _lastConfirmation.finalOutcome,
                confirmationSignals: _lastConfirmation.confirmationSignals,
              },
            });
            _endConfirming();
            return logRunSummary({
              status:   'unconfirmed',
              message:  _message_fw,
              screenshotPath,
              phase:    'post_click',
              reason:   _reason,
              category: 'post_click',
              label:    _label_fw,
              url:      page.url(),
              recorded: true,
              finalOutcome:        _lastConfirmation.finalOutcome,
              confirmationSignals: _lastConfirmation.confirmationSignals,
            });
          }
          // ── End Stage 10E POINT 6 (full→waitlist) ──────────────────────────
        }
        // ─────────────────────────────────────────────────────────────────
        _replayAction = 'register';
        replayStore.addEvent(_jobId, 'action_attempt', 'Clicked Register', `Attempt ${attempt}`);
        _tc.actionClickAt = new Date().toISOString();
        await registerBtn.first().click();
        // ── Stage 10E POINT 6 (Register) — strong post-click confirmation ──
        _state.isConfirming    = true;
        _state.confirmingPhase = attempt > 1
          ? `Retry ${attempt} of ${maxAttempts} · confirming…`
          : 'Confirming booking outcome…';
        saveState(_state);
        _tc.confirmation_check_start = new Date().toISOString();
        _lastConfirmation = await confirmBookingOutcome(page, 'register', _attemptModalScope);
        _tc.confirmation_check_done = new Date().toISOString();
        _state.isConfirming    = false;
        _state.confirmingPhase = null;
        console.log(`[stage-10e] Register: finalOutcome=${_lastConfirmation.finalOutcome} signals=${JSON.stringify(_lastConfirmation.confirmationSignals)}`);
        if (_lastConfirmation.finalOutcome === 'booked' || _lastConfirmation.finalOutcome === 'waitlisted') {
          replayStore.addEvent(_jobId, 'confirm', `Registration confirmed (Stage 10E outcome=${_lastConfirmation.finalOutcome})`);
          console.log(`SUCCESS: Registered for ${classTitle} ${classTimeNorm || classTime} with ${instructor || 'Stephanie'} (outcome=${_lastConfirmation.finalOutcome})`);
          registered = true;
          break;
        }
        // still_open or ambiguous → record structured failure and exit attempt
        // loop with new "unconfirmed" status (Stage 10E mapping).
        {
          await captureFailure('post_click', 'unconfirmed');
          const _reason = _lastConfirmation.finalOutcome === 'still_open'
            ? 'click_silent_no_op'
            : 'registration_unclear';
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'post_click', reason: _reason,
            category: 'post_click',
            label:    `Register outcome: ${_lastConfirmation.finalOutcome}`,
            message:  `Register clicked but post-click outcome was "${_lastConfirmation.finalOutcome}" after up to 10 s of re-checks.`,
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  {
              attempt,
              finalOutcome:        _lastConfirmation.finalOutcome,
              confirmationSignals: _lastConfirmation.confirmationSignals,
            },
          });
          _endConfirming();
          return logRunSummary({
            status:   'unconfirmed',
            message:  `Register clicked but the booking could not be confirmed (finalOutcome=${_lastConfirmation.finalOutcome}).`,
            screenshotPath,
            phase:    'post_click',
            reason:   _reason,
            category: 'post_click',
            label:    `Register outcome: ${_lastConfirmation.finalOutcome}`,
            url:      page.url(),
            recorded: true,
            finalOutcome:        _lastConfirmation.finalOutcome,
            confirmationSignals: _lastConfirmation.confirmationSignals,
          });
        }
        // ── End Stage 10E POINT 6 (Register) ──────────────────────────────
      } else if (hasWaitlist) {
        if (DRY_RUN) {
          console.log('DRY RUN: Would click Waitlist button. Done.');
          registered = true;
          break;
        }
        _replayAction = 'waitlist';
        replayStore.addEvent(_jobId, 'action_attempt', 'Clicked Join Waitlist', `Attempt ${attempt}`);
        _tc.actionClickAt = new Date().toISOString();
        // Stage 3: capture pre-click snapshot for already_waitlisted /
        // no_state_change detection in confirmBookingOutcome.
        const _preClickSnap_wl = await capturePreClickSnapshot(page, _attemptModalScope);
        await waitlistBtn.first().click();
        // Task #99 — FW waitlist flow has a 2-step confirmation: after the
        // first click, a small popup appears with the user's name and a
        // "Reserve" + "Close" button pair. Click Reserve so the waitlist
        // join is actually committed before the Stage 10E classifier reads
        // the post-click DOM. No-op when the popup never appears.
        const _reservePopup_wl = await clickWaitlistReserveConfirmation(
          page, undefined, { jobId: job.id || job.jobId || null },
        );
        if (_reservePopup_wl.popupSeen) {
          const _posSuffix_wl = _reservePopup_wl.waitlistPosition != null
            ? ` (position #${_reservePopup_wl.waitlistPosition})`
            : '';
          replayStore.addEvent(_jobId, 'action_attempt',
            _reservePopup_wl.clicked
              ? `Clicked Reserve confirmation popup (waitlist 2-step)${_posSuffix_wl}`
              : `Reserve confirmation popup detected but click failed: ${_reservePopup_wl.error || 'unknown'}`,
            `Attempt ${attempt}`);
        }
        // ── Stage 10E POINT 6 (Waitlist) — strong post-click confirmation ──
        _state.isConfirming    = true;
        _state.confirmingPhase = attempt > 1
          ? `Retry ${attempt} of ${maxAttempts} · confirming…`
          : 'Confirming booking outcome…';
        saveState(_state);
        _tc.confirmation_check_start = new Date().toISOString();
        _lastConfirmation = await confirmBookingOutcome(page, 'waitlist', _attemptModalScope, _preClickSnap_wl);
        _tc.confirmation_check_done = new Date().toISOString();
        _state.isConfirming    = false;
        _state.confirmingPhase = null;
        // Task #101: enrich confirmationSignals with the post-Reserve popup
        // state so failure context + run summaries carry it.
        if (_lastConfirmation.confirmationSignals && typeof _lastConfirmation.confirmationSignals === 'object') {
          _lastConfirmation.confirmationSignals.popupConfirmedState = _reservePopup_wl.confirmedState ?? null;
          _lastConfirmation.confirmationSignals.waitlistPosition    = _reservePopup_wl.waitlistPosition ?? null;
        }
        console.log(`[stage-10e] Waitlist: finalOutcome=${_lastConfirmation.finalOutcome} signals=${JSON.stringify(_lastConfirmation.confirmationSignals)}`);
        // Stage 3 success outcomes: booked, waitlisted, waitlist_joined, already_waitlisted
        if (_lastConfirmation.finalOutcome === 'booked' ||
            _lastConfirmation.finalOutcome === 'waitlisted' ||
            _lastConfirmation.finalOutcome === 'waitlist_joined' ||
            _lastConfirmation.finalOutcome === 'already_waitlisted') {
          // Task #101: persist position so /api/state can surface it.
          // Always write — when the badge wasn't captured this run, clear
          // any cached position so the UI doesn't show a stale "#N" from
          // a prior run on the same job.
          const _pos_wl = _reservePopup_wl.waitlistPosition ?? null;
          try {
            const _jid = job.id || job.jobId || null;
            if (_pos_wl != null) waitlistPositionStore.set(_jid, _pos_wl);
            else                 waitlistPositionStore.clear(_jid);
          } catch (_) {}
          const _label_wl_ok = _waitlistLabel(_lastConfirmation.finalOutcome, _pos_wl);
          replayStore.addEvent(_jobId, 'confirm', `${_label_wl_ok} (Stage 10E outcome=${_lastConfirmation.finalOutcome})`);
          console.log(`WAITLIST: ${_label_wl_ok} for ${classTitle} ${classTimeNorm || classTime} (outcome=${_lastConfirmation.finalOutcome})`);
          registered = true;
          break;
        }
        // no_state_change / ambiguous / auth_interrupted → structured failure
        {
          await captureFailure('post_click', 'unconfirmed');
          // Stage 3 reason mapping (replaces still_open/ambiguous-only mapping)
          const _reason =
            _lastConfirmation.finalOutcome === 'auth_interrupted' ? 'auth_redirect_during_action' :
            _lastConfirmation.finalOutcome === 'no_state_change'  ? 'click_no_op_verified' :
                                                                     'registration_unclear';
          // Stage 4: truthful operator-facing label & message keyed on outcome
          // Task #101: include the position when the helper saw it (rare on
          // failure paths, but harmless when null).
          const _pos_wl_fail = _reservePopup_wl.waitlistPosition ?? null;
          const _label_wl   = _waitlistLabel(_lastConfirmation.finalOutcome, _pos_wl_fail);
          const _message_wl = _waitlistMessage(_lastConfirmation.finalOutcome, _pos_wl_fail);
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'post_click', reason: _reason,
            category: 'post_click',
            label:    _label_wl,
            message:  _message_wl,
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  {
              attempt,
              finalOutcome:        _lastConfirmation.finalOutcome,
              confirmationSignals: _lastConfirmation.confirmationSignals,
            },
          });
          _endConfirming();
          return logRunSummary({
            status:   'unconfirmed',
            message:  _message_wl,
            screenshotPath,
            phase:    'post_click',
            reason:   _reason,
            category: 'post_click',
            label:    _label_wl,
            url:      page.url(),
            recorded: true,
            finalOutcome:        _lastConfirmation.finalOutcome,
            confirmationSignals: _lastConfirmation.confirmationSignals,
          });
        }
        // ── End Stage 10E POINT 6 (Waitlist) ──────────────────────────────
      } else {
        // No Register or Waitlist button visible.
        // On the first attempt, decide whether to wait (booking opens soon) or
        // report "found but not open" immediately so the scheduler can retry.
        if (attempt === 1) {
          let msUntilBwOpen = Infinity;
          try {
            const { bookingOpen: bwNow } = getBookingWindow(job);
            if (bwNow) msUntilBwOpen = bwNow.getTime() - Date.now();
          } catch { /* ignore — conservative: stay in loop */ }

          if (msUntilBwOpen > 15 * 60 * 1000) {
            // Booking window is more than 15 min away — class is on the schedule
            // but registration is not open.  Return informational status immediately
            // rather than spinning for 10 minutes.
            const classDesc = [
              classTitle,
              `${dayShort}${targetDayNum ? ' ' + targetDayNum : ''}`,
              classTimeNorm || classTime,
              instructor || 'Stephanie',
            ].join(' · ');
            const _minUntilOpen = Math.round(msUntilBwOpen / 60000);
            const msg = `Modal opened and verified for ${classDesc} — no registration button visible yet. Booking window opens in ${_minUntilOpen} min. Bot will retry during the booking window.`;
            console.log('ℹ️  ' + msg);
            await captureFailure('gate', 'uncertain_state');
            // ── POINT 4: gate — early exit (booking window far off) ────────
            recordFailure({
              jobId:    job.id || job.jobId || null,
              phase:    'gate', reason: 'booking_not_open',
              category: 'gate', label: 'Modal verified — registration not open yet (exiting early)',
              message:  msg, classTitle,
              screenshot: _screenshotRef(screenshotPath),
              url:      page.url(),
              context:  { msUntilBwOpen: Math.round(msUntilBwOpen / 1000) + 's', attempt },
            });
            // ─────────────────────────────────────────────────────────────
            return logRunSummary({ status: 'found_not_open_yet', message: msg, screenshotPath });
          }
          // Within 15-min sniper window — keep polling quickly.
          console.log(`Attempt 1: No register/waitlist button. Booking window opens in ${Math.round(msUntilBwOpen / 1000)}s — polling every 5s...`);
        } else {
          if (attempt > 1) replayStore.addEvent(_jobId, 'retry', 'Retrying — no button yet', `Attempt ${attempt}`);
          console.log(`Attempt ${attempt}: No register/waitlist button.` + (DRY_RUN ? ' (dry run — pausing 10s)' : ' Retrying in 5s...'));
        }
        if (DRY_RUN) { await page.waitForTimeout(10000); break; }
        await page.waitForTimeout(5000);
        await page.reload();
        // 8-second cap: FamilyWorks SPA keeps background XHRs open and may
        // never reach "networkidle", hanging the bot for Playwright's 30-second
        // default.  8 s is well above the observed 2-4 s for the initial page
        // render + data fetch on a fast connection.
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(3000);

        // Re-find the correct day tab after reload, using exact-date if available.
        const dayTabsRetry     = page.locator(`text=/${dayShort} \\d+/`);
        const dayTabCountRetry = await dayTabsRetry.count();
        if (targetDayNum !== null) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            const tabText = await dayTabsRetry.nth(w).textContent();
            if (parseInt(tabText.replace(/\D+/g, ''), 10) === targetDayNum) {
              await dayTabsRetry.nth(w).click();
              targetCard = await findCardOnTab(tabText.trim());
              break;
            }
          }
        }
        if (!targetCard) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            const tabText = await dayTabsRetry.nth(w).textContent();
            await dayTabsRetry.nth(w).click();
            targetCard = await findCardOnTab(tabText.trim());
            if (targetCard) break;
          }
        }

        // ── POINT 8: recovery — stale card after reload ───────────────────
        if (!targetCard) {
          console.log(`⚠️ [attempt ${attempt}] Card not found after reload — cannot re-open modal.`);
          await captureFailure('recovery', 'stale_card_recovery_failed');
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'recovery', reason: 'stale_card_recovery_failed',
            category: 'recovery', label: 'Class card missing after page reload',
            message:  `Attempt ${attempt}: could not re-locate class card after page reload`,
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  { attempt, dayShort, targetDayNum, pollTabText, dayTabCountRetry },
          });
        }
        // ─────────────────────────────────────────────────────────────────

        if (targetCard) {
          try {
            await targetCard.scrollIntoViewIfNeeded({ timeout: 5000 });
          } catch (scrollErr) {
            console.log('⚠️ Retry scrollIntoViewIfNeeded timed out:', scrollErr.message.split('\n')[0]);
          }
          await page.waitForTimeout(300);
          const retryBox = await targetCard.boundingBox({ timeout: 5000 }).catch(() => null);
          console.log('Retry card visible:', await targetCard.isVisible({ timeout: 5000 }).catch(() => false), '| box:', JSON.stringify(retryBox));
          const clickableRetry = targetCard.locator("button, a, [role='button'], [tabindex='0']").first();
          const hasClickableRetry = (await clickableRetry.count()) > 0;
          if (DEBUG_HIGHLIGHT) {
            await highlightElement(page, hasClickableRetry ? clickableRetry : targetCard);
            await page.waitForTimeout(400);
          }
          if (DEBUG_PAUSE) {
            console.log('⏸  Pausing before retry click — Playwright Inspector is open.');
            console.log('👉 Hover elements, test selectors, then press Resume to continue.');
            await page.pause();
          }
          try {
            if (hasClickableRetry) {
              await clickableRetry.click({ timeout: 5000 });
            } else {
              await targetCard.click({ timeout: 5000 });
            }
          } catch (retryErr) {
            console.log('⚠️ Retry click fallback:', retryErr.message.split('\n')[0]);
            if (hasClickableRetry) {
              await clickableRetry.click({ force: true, timeout: 5000 });
            } else {
              await targetCard.click({ force: true, timeout: 5000 });
            }
          }

          // ── Retry modal verification ───────────────────────────────────────
          // The simplified re-click above bypasses attemptClickAndVerify, so we
          // do a lightweight time-check here to catch wrong-modal openings.
          // Signal-driven: wait up to 3 s for [role="dialog"] to appear (same
          // cap as the primary click path), then verify the class time is present.
          const _retryDialog = await page.waitForSelector('[role="dialog"]', { timeout: 3000 }).catch(() => null);
          if (_retryDialog && classTimeNorm) {
            // Give action buttons a moment to populate modal text.
            await page.waitForSelector(
              ACTION_SELECTORS.modalReady.split(', ').map(s => `[role="dialog"] ${s}`).join(', '),
              { timeout: 500 }
            ).catch(() => null);

            // Read modal text using the same scoped evaluate as the primary path.
            // Use innerText (layout-aware) so Bubble.io CSS-rendered text is captured.
            let _retryModalText = await page.evaluate((modalSel) => {
              const norm = t => (t || '').replace(/[\u00A0\u2009\u202f]+/g, ' ').toLowerCase();
              const dialog = document.querySelector('[role="dialog"]');
              const btn = dialog ? dialog.querySelector(modalSel) : document.querySelector(modalSel);
              if (btn) {
                let node = btn.parentElement;
                for (let i = 0; i < 12 && node && node !== document.body; i++) {
                  const txt = norm((node.innerText || node.textContent) || '').trim();
                  if (txt.length > 80) return txt;
                  node = node.parentElement;
                }
                if (dialog) return norm((dialog.innerText || dialog.textContent) || '');
              }
              return norm(((dialog || document.body).innerText || (dialog || document.body).textContent) || '');
            }, ACTION_SELECTORS.modalReady).catch(() => '');
            if (!_retryModalText || _retryModalText.length < 10) {
              const _fb = await page.locator('[role="dialog"]').innerText({ timeout: 1500 }).catch(() => '')
                || await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
              _retryModalText = (_fb || '').replace(/[\u00A0\u2009\u202f]+/g, ' ').toLowerCase();
            }

            if (_retryModalText.includes(classTimeNorm)) {
              console.log(`[retry-modal] attempt ${attempt}: modal identity confirmed (time "${classTimeNorm}" present).`);
              await page.waitForTimeout(300); // brief settle after verified dialog
            } else {
              // Wrong modal — the re-click opened a different class row's detail.
              // Return an error (not not_found) because the class WAS found on the
              // schedule and modal reached was already recorded (_state.bundle.modal).
              const _retryPreview = _retryModalText.slice(0, 150);
              console.warn(`⚠️ [retry-modal] attempt ${attempt}: reopened modal shows wrong class — expected time "${classTimeNorm}" absent.`);
              console.warn(`   Modal preview: ${_retryPreview}`);
              await captureFailure('verify', 'time_mismatch');
              emitFailure('VERIFY', 'VERIFY_TIME_MISMATCH',
                `Retry attempt ${attempt}: reopened modal showed wrong class (expected time "${classTimeNorm}" absent)`,
                { evidence: { attempt, classTimeNorm, modalPreview: _retryPreview } }
              );
              return logRunSummary({
                status:   'error',
                message:  `Class found on schedule but retry modal showed wrong class — expected time "${classTimeNorm}" not found in reopened modal (attempt ${attempt}).`,
                screenshotPath,
                phase:    'verify',
                reason:   'modal_wrong_class',
                category: 'verify',
                label:    'Retry: modal identity mismatch',
                url:      page.url(),
              });
            }
          } else if (!_retryDialog) {
            // Modal did not open — log and fall through.  The next iteration's
            // detectActionButtons will return empty and the loop continues normally.
            console.log(`[retry-modal] attempt ${attempt}: no dialog appeared after re-click — continuing to next poll.`);
            await page.waitForTimeout(2000); // preserve original settle when no dialog
          }
          // ─────────────────────────────────────────────────────────────────
        } else {
          // No card to click — preserve original 2 s settle so the loop doesn't spin.
          await page.waitForTimeout(2000);
        }
      }
    }

    // Attempt loop complete — close out any open timing windows.
    if (!_tc.action_attempt_done)      _tc.action_attempt_done      = new Date().toISOString();
    if (!_tc.first_click_attempt_done) _tc.first_click_attempt_done = new Date().toISOString();

    // Task #60 — clear any residual confirming sub-phase from a successful
    // (registered=true; break) exit out of the cascade so the readiness API
    // doesn't continue reporting "Re-checking schedule…" after we're done.
    _endConfirming();

    if (!registered) {
      const classDesc = [
        classTitle,
        `${dayShort}${targetDayNum ? ' ' + targetDayNum : ''}`,
        classTimeNorm || classTime,
        instructor || 'Stephanie',
      ].join(' · ');
      const msg = `Modal opened and verified for ${classDesc} — registration button did not appear within the retry window. Bot will retry at the next scheduler cycle.`;
      console.log('ℹ️  ' + msg);
      await captureFailure('gate', 'uncertain_state');
      // ── POINT 4: gate — exhausted retry window ─────────────────────────
      recordFailure({
        jobId:    job.id || job.jobId || null,
        phase:    'gate', reason: 'booking_not_open',
        category: 'gate', label: 'Modal verified — registration button did not appear within retry window',
        message:  msg, classTitle,
        screenshot: _screenshotRef(screenshotPath),
        url:      page.url(),
        context:  { maxAttempts },
      });
      // ─────────────────────────────────────────────────────────────────
      return logRunSummary({ status: 'found_not_open_yet', message: msg, screenshotPath });
    }

    const successMsg = DRY_RUN
      ? `DRY RUN complete for ${classTitle}`
      : `Registered for ${classTitle} with Stephanie`;
    await snap();
    // Replay: terminal outcome event
    if (!PREFLIGHT_ONLY) {
      if (_replayAction === 'waitlist') {
        // Task #101: include the captured FW position in the terminal
        // replay event ("Joined waitlist · #10") when known, so the run
        // log mirrors the UI badge. Falls back to plain text otherwise.
        const _termPos =
          (_lastConfirmation && _lastConfirmation.confirmationSignals &&
           _lastConfirmation.confirmationSignals.waitlistPosition) || null;
        const _termMsg = _termPos != null && Number.isFinite(_termPos)
          ? `Joined waitlist · #${_termPos}`
          : 'Joined waitlist';
        replayStore.addEvent(_jobId, 'waitlist', _termMsg, classTitle);
      } else {
        replayStore.addEvent(_jobId, 'success', 'Booking confirmed', classTitle);
      }
    }
    // Stage 10E — capture a structured post-click outcome (booked / waitlisted /
    // still_open / ambiguous) and the raw signals that produced the verdict.
    // Surfaced on the run result and persisted via emitSuccess → saveState so
    // the readiness bundle reflects the verified booking outcome.
    // Prefer the click-site outcome captured by confirmBookingOutcome(), which
    // is the authoritative success verdict (booked / waitlisted) from POINT 6.
    // Fall back to a fresh terminal snapshot only if no click-site result was
    // recorded (e.g. legacy code paths or DRY_RUN flows).
    let _confirmation = (_lastConfirmation && _lastConfirmation.finalOutcome)
      ? _lastConfirmation
      : { finalOutcome: null, confirmationSignals: null };
    if (!DRY_RUN && !_confirmation.finalOutcome) {
      try {
        const _attemptedAction = _replayAction === 'waitlist' ? 'waitlist' : 'register';
        _state.isConfirming    = true;
        _state.confirmingPhase = 'Capturing final outcome…';
        saveState(_state);
        _confirmation = await confirmBookingOutcome(page, _attemptedAction);
        console.log(`[stage-10e] terminal finalOutcome=${_confirmation.finalOutcome} signals=${JSON.stringify(_confirmation.confirmationSignals)}`);
      } catch (e) {
        console.warn('[stage-10e] confirmBookingOutcome failed:', e.message);
      } finally {
        _state.isConfirming    = false;
        _state.confirmingPhase = null;
      }
    } else if (_confirmation.finalOutcome) {
      console.log(`[stage-10e] reusing click-site finalOutcome=${_confirmation.finalOutcome}`);
    }
    emitSuccess(_state, _confirmation);
    _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'booking', detail: 'Booking completed successfully — FamilyWorks session confirmed active' });
    // Derive top-level status from the authoritative finalOutcome when
    // available so a Register click that actually joined a waitlist (the
    // class filled between scrape and click) reports as "waitlist" instead
    // of "booked".  Falls back to _replayAction for parity with legacy code.
    const _terminalStatus =
      _confirmation.finalOutcome === 'waitlisted' ? 'waitlist' :
      _confirmation.finalOutcome === 'booked'     ? 'booked'   :
      (_replayAction === 'waitlist' ? 'waitlist' : 'booked');
    return logRunSummary({
      status: _terminalStatus,
      message: successMsg,
      screenshotPath,
      finalOutcome:        _confirmation.finalOutcome,
      confirmationSignals: _confirmation.confirmationSignals,
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    // Task #60 — clear any in-progress confirming sub-phase so an unexpected
    // throw mid-cascade doesn't leave the readiness API reporting
    // "Verifying on detail page…" forever.  Inlined (rather than calling
    // _endConfirming) because that helper is block-scoped inside the try.
    try {
      if (_state && (_state.isConfirming || _state.confirmingPhase)) {
        _state.isConfirming = false;
        _state.confirmingPhase = null;
        saveState(_state);
      }
    } catch { /* non-fatal — state file write failure is just stale UI */ }
    if (!PREFLIGHT_ONLY) replayStore.addEvent(_jobId, 'failure', 'Booking failed', err.message.split('\n')[0]);
    // Playwright renderer crash ("page.goto: Page crashed") — the Chrome process was
    // killed by the OS (OOM / segfault).  A fresh browser launch on the next attempt
    // will succeed.  Classify as a transient navigate failure so retry-strategy picks
    // it up as PAGE_CRASHED and schedules a fast retry instead of escalating.
    if (/Page crashed/i.test(err.message)) {
      return logRunSummary({ status: 'error', message: err.message, screenshotPath, phase: 'navigate', reason: 'page_crashed', category: 'system', label: 'Playwright renderer crash (transient)' });
    }
    return logRunSummary({ status: 'error', message: err.message, screenshotPath, phase: 'system', reason: 'unexpected_error', category: 'system', label: 'Unhandled exception in booking job' });
  } finally {
    // ── Compute and persist timing deltas (Stage 2: full marker set) ─────────
    // Always persist the complete _tc snapshot so every run produces a
    // timing trail, even runs that exit early (auth fail, not_found, etc.).
    // Derived delta fields (ms) are computed inline from the ISO timestamps.
    const _openMs = _tc.bookingOpenAt ? new Date(_tc.bookingOpenAt).getTime() : null;
    recordTiming(_state, {
      // ── Raw ISO markers ───────────────────────────────────────────────────
      run_start:                  _tc.run_start,
      session_ping_start:         _tc.session_ping_start,
      session_ping_done:          _tc.session_ping_done,
      browser_launch_start:       _tc.browser_launch_start,
      browser_launch_done:        _tc.browser_launch_done,
      page_nav_start:             _tc.page_nav_start,
      page_nav_done:              _tc.page_nav_done,
      filter_apply_start:         _tc.filter_apply_start,
      filter_apply_done:          _tc.filter_apply_done,
      class_discovery_start:      _tc.class_discovery_start,
      class_discovery_done:       _tc.class_discovery_done,
      modal_open_start:           _tc.modal_open_start,
      modal_open_done:            _tc.modal_open_done,
      card_click_start:           _tc.card_click_start,
      card_click_done:            _tc.card_click_done,
      modal_wait_start:           _tc.modal_wait_start,
      modal_wait_done:            _tc.modal_wait_done,
      modal_verify_start:         _tc.modal_verify_start,
      modal_verify_done:          _tc.modal_verify_done,
      modal_ready_at:             _tc.modal_ready_at,
      action_ready_at:            _tc.action_ready_at,
      first_click_attempt_start:  _tc.first_click_attempt_start,
      first_click_attempt_done:   _tc.first_click_attempt_done,
      action_attempt_start:       _tc.action_attempt_start,
      action_attempt_done:        _tc.action_attempt_done,
      confirmation_check_start:   _tc.confirmation_check_start,
      confirmation_check_done:    _tc.confirmation_check_done,
      bookingOpenAt:              _tc.bookingOpenAt,
      cardFoundAt:                _tc.cardFoundAt,
      actionClickAt:              _tc.actionClickAt,
      final_outcome:              _tc.final_outcome,
      // ── Derived delta fields (ms) — null when either endpoint missing ──────
      session_ping_ms:      (_tc.session_ping_start && _tc.session_ping_done)
        ? new Date(_tc.session_ping_done).getTime()  - new Date(_tc.session_ping_start).getTime()  : null,
      browser_launch_ms:    (_tc.browser_launch_start && _tc.browser_launch_done)
        ? new Date(_tc.browser_launch_done).getTime() - new Date(_tc.browser_launch_start).getTime() : null,
      page_nav_ms:          (_tc.page_nav_start && _tc.page_nav_done)
        ? new Date(_tc.page_nav_done).getTime()       - new Date(_tc.page_nav_start).getTime()       : null,
      class_discovery_ms:   (_tc.class_discovery_start && _tc.class_discovery_done)
        ? new Date(_tc.class_discovery_done).getTime() - new Date(_tc.class_discovery_start).getTime() : null,
      modal_open_ms:        (_tc.modal_open_start && _tc.modal_open_done)
        ? new Date(_tc.modal_open_done).getTime()     - new Date(_tc.modal_open_start).getTime()     : null,
      first_attempt_ms:     (_tc.first_click_attempt_start && _tc.first_click_attempt_done)
        ? new Date(_tc.first_click_attempt_done).getTime() - new Date(_tc.first_click_attempt_start).getTime() : null,
      confirmation_ms:      (_tc.confirmation_check_start && _tc.confirmation_check_done)
        ? new Date(_tc.confirmation_check_done).getTime() - new Date(_tc.confirmation_check_start).getTime()   : null,
      filter_apply_ms:      (_tc.filter_apply_start && _tc.filter_apply_done)
        ? new Date(_tc.filter_apply_done).getTime()  - new Date(_tc.filter_apply_start).getTime()    : null,
      card_click_ms:        (_tc.card_click_start && _tc.card_click_done)
        ? new Date(_tc.card_click_done).getTime()    - new Date(_tc.card_click_start).getTime()      : null,
      modal_wait_ms:        (_tc.modal_wait_start && _tc.modal_wait_done)
        ? new Date(_tc.modal_wait_done).getTime()    - new Date(_tc.modal_wait_start).getTime()      : null,
      modal_verify_ms:      (_tc.modal_verify_start && _tc.modal_verify_done)
        ? new Date(_tc.modal_verify_done).getTime()  - new Date(_tc.modal_verify_start).getTime()    : null,
      modal_to_action_ready_ms: (_tc.modal_ready_at && _tc.action_ready_at)
        ? new Date(_tc.action_ready_at).getTime()    - new Date(_tc.modal_ready_at).getTime()        : null,
      run_start_to_nav_ms:  (_tc.run_start && _tc.page_nav_start)
        ? new Date(_tc.page_nav_start).getTime()     - new Date(_tc.run_start).getTime()             : null,
      openToCardMs:         (_openMs && _tc.cardFoundAt)
        ? new Date(_tc.cardFoundAt).getTime()   - _openMs : null,
      openToClickMs:        (_openMs && _tc.actionClickAt)
        ? new Date(_tc.actionClickAt).getTime() - _openMs : null,
      pollAttemptsPostOpen: _tc.pollAttemptsPostOpen,
    });
    // Stage 3: derive human-readable first-attempt metrics and attach to state.
    // deriveTimingMetrics() is a pure function — it never throws.
    try {
      const _metrics = deriveTimingMetrics(_state.timing);
      if (_metrics) {
        recordTimingMetrics(_state, _metrics);
        console.log('[timing-metrics]', JSON.stringify(_metrics));
      }
    } catch (metricsErr) {
      console.warn('[timing-metrics] derive failed:', metricsErr.message);
    }
    // Stage 7: Detect timing degradation vs the per-job learned baseline.
    // Compares auth_phase_ms, run_start_to_page_ready, page_ready_to_class_found
    // against the medians that timing-learner has accumulated over past runs.
    // No-ops gracefully when < MIN_OBS (3) speed observations exist.
    try {
      if (_state.timingMetrics) {
        const _jobNumId    = job.id || job.jobId || null;
        const _learnedSpeed = _jobNumId != null ? getLearnedRunSpeed(_jobNumId) : null;
        const _degradation  = detectTimingDegradation(_state.timingMetrics, _learnedSpeed);
        if (_degradation) {
          _state.timingMetrics.degradation = _degradation;
          if (_degradation.detected) {
            const _slowList = _degradation.slowPhases
              .map(p =>
                `${p.phase}=${Math.round(p.currentMs / 1000)}s ` +
                `(median:${Math.round(p.medianMs / 1000)}s, ${p.ratioX}×)`
              )
              .join(', ');
            console.warn(`[timing-degradation] Job #${_jobNumId} — SLOW: ${_slowList}`);
          }
        }
      }
    } catch (degErr) {
      console.warn('[timing-degradation] detect failed:', degErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────
    saveState(_state);
    if (browser) await browser.close();
    if (_authLockAcquired) releaseLock();
  }
}

// ── Cancel Registration ───────────────────────────────────────────────────────
// Navigates to the YMCA schedule, finds the registered/waitlisted class,
// opens the modal, verifies it matches the job, and clicks Unregister /
// Cancel / Leave Waitlist.  Returns a structured result.
//
// Reuses: createSession, auth-lock, pingSessionHttp, saveCookies, ACTION_SELECTORS
// Does NOT touch the sniper state, booking windows, or booking locks.
// ─────────────────────────────────────────────────────────────────────────────
async function cancelRegistration(job) {
  const { classTitle, classTime, instructor, dayOfWeek, targetDate } = job;

  const classTitleLower   = (classTitle || '').toLowerCase();
  const classTimeNorm     = classTime
    ? classTime.trim().toLowerCase().replace(/^(\d+:\d+)\s*(am|pm).*/, (_, t, ap) => t + ' ' + ap[0])
    : null;
  const instructorFirstName = instructor
    ? instructor.trim().split(/\s+/)[0].toLowerCase()
    : null;

  const DAY_SHORT = {
    Sunday:'Sun', Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed',
    Thursday:'Thu', Friday:'Fri', Saturday:'Sat',
  };
  let dayShort    = DAY_SHORT[dayOfWeek] || 'Wed';
  let targetDayNum = null;
  if (targetDate) {
    const d    = new Date(targetDate + 'T00:00:00Z');
    dayShort   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    targetDayNum = d.getUTCDate();

    // Consistency check: log a warning if stored day_of_week disagrees with the
    // calendar weekday of target_date.  cancelRegistration already uses target_date
    // as the source of truth — this makes any override explicit in logs.
    const wc = checkJobConsistency(job);
    if (!wc.isConsistent) {
      console.warn(
        `[job-consistency] cancelRegistration: stored day_of_week "${dayOfWeek}" ` +
        `does not match target_date ${targetDate} (${wc.computedWeekday}). ` +
        `Tab selection will use "${dayShort} ${targetDayNum}" from target_date — ` +
        `ignoring stale day_of_week label.`
      );
    }
  }

  const CONFIDENCE_THRESHOLD = 8;

  let browser = null;
  let _authLockAcquired = false;

  // ── DOM eval: find the best-matching card on the current page ─────────────
  // Same scoring logic as the inner findTargetCard() in runBookingJob.
  async function findCard(page) {
    await page.evaluate(() => {
      document.querySelectorAll('[data-cancel-target]').forEach(e => e.removeAttribute('data-cancel-target'));
    });
    const result = await page.evaluate(({ classTitleLower, instrFirst, confidenceThreshold, classTimeNorm }) => {
      const SKIP = new Set(['OPTION','SELECT','SCRIPT','STYLE','HEAD','HTML','BODY','NOSCRIPT','SVG','PATH']);
      function norm(t) { return (t||'').replace(/[\s\u00A0\u2009\u202f]+/g,' ').trim(); }
      let timeAmRe;
      if (classTimeNorm) {
        const m = classTimeNorm.match(/^(\d+:\d+)\s*([ap])/i);
        timeAmRe = m ? new RegExp(m[1]+'\\s*'+m[2],'i') : /(?!)/;
      } else { timeAmRe = /(?!)/; }
      const titleParts = classTitleLower.split(/\s+/).map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
      const titleRe  = new RegExp(titleParts.join('[\\s\\u00A0]+'),'i');
      const instrRe  = instrFirst ? new RegExp(instrFirst,'i') : /(?!)/;
      const rows = [];
      for (const el of document.querySelectorAll('*')) {
        if (SKIP.has(el.tagName)) continue;
        const desc = el.querySelectorAll('*').length;
        if (desc > 100 || desc < 2) continue;
        const txt  = norm(el.textContent||'');
        if (!txt) continue;
        const r = el.getBoundingClientRect();
        if (r.width===0 && r.height===0) continue;
        const hasTitle = titleRe.test(txt);
        const hasTime  = timeAmRe.test(txt);
        const hasInstr = instrFirst ? instrRe.test(txt) : false;
        let score = 0;
        if (hasTitle) score+=5;
        if (hasTime)  score+=5;
        if (hasInstr) score+=3;
        if (score < confidenceThreshold) continue;
        rows.push({ el, score, desc, visible: r.width>=100 && r.height>=30, txt:txt.slice(0,200) });
      }
      rows.sort((a,b)=>b.score-a.score||(b.visible?1:0)-(a.visible?1:0)||a.desc-b.desc);
      if (!rows.length) return null;
      rows[0].el.setAttribute('data-cancel-target','yes');
      return { score: rows[0].score, txt: rows[0].txt };
    }, { classTitleLower, instrFirst: instructorFirstName, confidenceThreshold: CONFIDENCE_THRESHOLD, classTimeNorm });
    if (!result) return null;
    console.log(`[cancel] Card found — score=${result.score} "${result.txt.slice(0,80)}"`);
    return page.locator('[data-cancel-target="yes"]').first();
  }

  // ── Scroll helper — find the largest scrollable panel and shift it ────────
  async function scrollPanel(page, amount) {
    await page.evaluate((amt) => {
      let best = null, bestH = 0;
      for (const el of document.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        if (s.overflowY!=='auto'&&s.overflowY!=='scroll'&&s.overflow!=='auto'&&s.overflow!=='scroll') continue;
        if (el.scrollHeight<=el.clientHeight+50) continue;
        const r = el.getBoundingClientRect();
        if (r.width<100||r.height<100) continue;
        if (r.height>bestH){best=el;bestH=r.height;}
      }
      if (best) best.scrollTop += amt;
    }, amount);
  }

  // ── Find card with scroll scan ────────────────────────────────────────────
  async function findCardWithScan(page) {
    let card = await findCard(page);
    if (card) return card;
    // Scroll up (reset to top first, then gentle scan down)
    await scrollPanel(page,-999999); await page.waitForTimeout(50);
    card = await findCard(page); if (card) return card;
    for (let i=0;i<40;i++) {
      await scrollPanel(page,120); await page.waitForTimeout(50);
      card = await findCard(page); if (card) return card;
    }
    return null;
  }

  // ── Stage 2: quick truth re-check ────────────────────────────────────────
  // Called after any cancel failure while the browser is still open.
  // Closes any open modal and re-probes the class card to determine whether
  // the enrollment is still active on YMCA or has already been cleared.
  // Returns: { found, enrolled: true|false|null, reason }
  async function quickRecheckEnrollment(page) {
    try {
      console.log('[cancel:recheck] Starting quick enrollment re-check...');
      // Close any open modal/popup
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);

      // Find card — light search first, then one scroll attempt
      let card = await findCard(page);
      if (!card) {
        await scrollPanel(page, -999999);
        await page.waitForTimeout(50);
        card = await findCard(page);
      }
      if (!card) {
        console.log('[cancel:recheck] Card not found — likely removed from schedule');
        return { found: false, enrolled: null, reason: 'card_gone' };
      }

      // Click card to open modal
      try { await card.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
      const rc = card.locator("button, [role='button'], a").first();
      const rt = (await rc.count()) > 0 ? rc : card;
      await rt.click({ timeout: 5000 }).catch(() => {});
      await page.waitForSelector(ACTION_SELECTORS.modalReady, { timeout: 2500 }).catch(() => null);
      await page.waitForTimeout(150);

      const btns = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(() => []);
      const hasRegister       = btns.some(t => /^register$/i.test(t.trim()));
      const hasViewReservation = btns.some(t => /view reservation|view waitlist/i.test(t.trim()));
      const hasCancelBtn      = btns.some(t => /unregister|leave waitlist|cancel registration/i.test(t));

      // Close modal again
      await page.keyboard.press('Escape').catch(() => {});

      console.log(`[cancel:recheck] Visible: ${JSON.stringify(btns)} → hasRegister:${hasRegister} hasViewRes:${hasViewReservation} hasCancel:${hasCancelBtn}`);

      if (hasRegister && !hasCancelBtn && !hasViewReservation) {
        return { found: true, enrolled: false, reason: 'register_visible' };
      }
      if (hasViewReservation || hasCancelBtn) {
        return { found: true, enrolled: true, reason: 'reservation_or_cancel_visible' };
      }
      return { found: true, enrolled: null, reason: 'ambiguous', buttons: btns };
    } catch (e) {
      console.log('[cancel:recheck] Error during re-check:', e.message);
      return { found: null, enrolled: null, reason: 'recheck_error', error: e.message };
    }
  }

  try {
    if (!classTitle) return { success:false, action:null, message:'Job is missing classTitle' };

    // ── Auth ─────────────────────────────────────────────────────────────────
    let _tier2Trusted = false;
    try {
      const ping = await pingSessionHttp();
      _tier2Trusted = ping.trusted === true;
    } catch { /* fall through to full auth */ }

    if (!_tier2Trusted) {
      if (isLocked()) return { success:false, action:null, message:'Auth lock held — another browser session is in progress' };
      _authLockAcquired = acquireLock('cancel','signing_in');
    }

    let _session;
    try {
      _session = await createSession({ headless: isHeadless });
    } catch (loginErr) {
      return { success:false, action:null, message: loginErr.message || 'Login failed' };
    }
    if (_authLockAcquired) { releaseLock(); _authLockAcquired = false; }

    browser = _session.browser;
    const page = _session.page;

    // ── Navigate ─────────────────────────────────────────────────────────────
    console.log('[cancel] Navigating to schedule...');
    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout:60000 });
    // Use domcontentloaded instead of networkidle — the Bubble.io SPA keeps
    // background XHR alive for 15-20 extra seconds after the page is usable.
    // The waitForFunction below (waiting for <select> options) is the real gate.
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const loginPrompt = await page.locator('text=/login to register/i').count();
    if (loginPrompt > 0) return { success:false, action:null, message:'Session not established — schedule page requires login' };

    // Wait for dropdowns
    await page.waitForFunction(() => {
      const sels = document.querySelectorAll('select');
      for (const s of sels) if (s.options.length>1) return true;
      return false;
    }, { timeout:15000 }).catch(()=>{});

    // ── Category filter ───────────────────────────────────────────────────────
    // Use native selectOption (works reliably as seen in logs).
    const selects = page.locator('select');
    const selCount = await selects.count();
    let filterApplied = false;
    for (let i=0;i<selCount;i++) {
      const opts = await selects.nth(i).locator('option').allTextContents();
      if (opts.some(o => /yoga.*pilates|pilates.*yoga/i.test(o))) {
        const before = await page.locator('[data-repeater-item], .bbl-rg-item, .schedule-row, [class*="rg-item"]').count().catch(()=>0);
        await selects.nth(i).selectOption({ label: 'Yoga/Pilates' });
        // Wait for the list to refresh after filtering — use a selector-based
        // gate so we don't over-sleep when the page is fast.
        await page.waitForSelector('[data-repeater-item], .bbl-rg-item, .schedule-row, [class*="rg-item"]', { timeout:600 }).catch(()=>{});
        await page.waitForTimeout(200);
        filterApplied = true;
        console.log(`[cancel] Yoga/Pilates filter applied (select #${i})`);
        break;
      }
    }
    if (!filterApplied) console.log('[cancel] ⚠️ Could not apply Yoga/Pilates filter — scanning without it.');
    await page.waitForTimeout(150);

    // ── Find day tab & card ───────────────────────────────────────────────────
    const dayTabs   = page.locator(`text=/${dayShort} \\d+/`);
    const tabCount  = await dayTabs.count();
    console.log(`[cancel] Found ${tabCount} "${dayShort}" tab(s).`);

    let card = null;

    if (targetDayNum !== null) {
      for (let w=0;w<tabCount;w++) {
        const tabTxt = await dayTabs.nth(w).textContent();
        if (parseInt(tabTxt.replace(/\D+/g,''),10) === targetDayNum) {
          console.log('[cancel] Clicking exact date tab: '+tabTxt.trim());
          await dayTabs.nth(w).click();
          card = await findCardWithScan(page);
          break;
        }
      }
    }
    if (!card) {
      for (let w=0;w<tabCount;w++) {
        const tabTxt = await dayTabs.nth(w).textContent();
        await dayTabs.nth(w).click();
        card = await findCardWithScan(page);
        if (card) { console.log('[cancel] Card found on tab: '+tabTxt.trim()); break; }
      }
    }

    if (!card) {
      // Stage 2: Is the class date already in the past?  If so, the card being
      // absent from the schedule is expected — enrollment was auto-cleared by YMCA.
      // Use midnight Pacific time as the comparison point so same-day classes
      // (e.g., a 4:20 PM class checked at 5 PM) are still caught.
      let datePassed = false;
      if (targetDate) {
        try {
          // targetDate is "YYYY-MM-DD". Compare date numerics in Pacific time.
          const [y, mo, d] = targetDate.split('-').map(Number);
          const nowPTDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
          datePassed = (nowPTDate.getFullYear() * 10000 + (nowPTDate.getMonth()+1) * 100 + nowPTDate.getDate())
                     > (y * 10000 + mo * 100 + d);
        } catch {}
      }
      console.log(`[cancel] Card not found — targetDate:${targetDate} datePassed:${datePassed}`);
      return {
        success:    false,
        action:     datePassed ? 'stale_state' : null,
        staleState: datePassed,
        message:    datePassed
          ? `Class card not found on schedule — date has passed, enrollment was likely auto-cleared by YMCA`
          : `Could not find class "${classTitle}" on the schedule`,
      };
    }

    // ── Open modal ────────────────────────────────────────────────────────────
    try { await card.scrollIntoViewIfNeeded({ timeout:5000 }); } catch {}
    await page.waitForTimeout(100);
    const clickable = card.locator("button, [role='button'], a").first();
    const clickTarget = (await clickable.count()) > 0 ? clickable : card;
    try {
      await clickTarget.scrollIntoViewIfNeeded({ timeout:3000 }).catch(()=>{});
      await clickTarget.click({ timeout:5000 });
    } catch {
      await card.click({ force:true });
    }

    // Wait for modal action buttons
    await page.waitForSelector(ACTION_SELECTORS.modalReady, { timeout:3000 }).catch(()=>null);
    await page.waitForTimeout(200);

    // ── "View Reservation" intermediary — FamilyWorks shows this button in the
    //    class detail modal when you're registered/waitlisted. Clicking it opens
    //    a second popup layer that has the actual "Cancel" / "#N On Waitlist" button.
    const viewReservationSel = 'button:has-text("View Reservation"), [role="button"]:has-text("View Reservation"), button:has-text("View Waitlist"), [role="button"]:has-text("View Waitlist")';
    const viewResBtns = page.locator(viewReservationSel);
    if ((await viewResBtns.count()) > 0) {
      console.log('[cancel] "View Reservation/Waitlist" button found — clicking through to reservation popup...');
      await viewResBtns.first().click({ timeout:5000 });
      // Wait for the popup's Cancel button (or a close/confirm action) rather than fixed sleep
      const cancelPopupReady = 'button:has-text("Cancel"), [role="button"]:has-text("Cancel"), button:has-text("Unregister"), [role="button"]:has-text("Unregister")';
      await page.waitForSelector(cancelPopupReady, { timeout:3000 }).catch(()=>null);
      await page.waitForTimeout(150);
    }

    // ── Modal verification ────────────────────────────────────────────────────
    const rawModal  = (await page.locator('body').innerText().catch(()=>'')).toLowerCase();
    const modalText = rawModal.replace(/[\u00A0\u2009\u202f]+/g,' ');
    // Use a flex-whitespace regex (e.g. "4:20\s*p") — the YMCA page sometimes
    // renders "4:20pm" (no space) where classTimeNorm is "4:20 p". Direct
    // String.includes("4:20 p") fails in that case; regex with \s* handles both.
    let verifyTime = !classTimeNorm; // if no classTimeNorm, skip check
    if (classTimeNorm) {
      const _m = classTimeNorm.match(/^(\d+:\d+)\s*([ap])/i);
      const timeRe = _m ? new RegExp(_m[1] + '\\s*' + _m[2], 'i') : null;
      verifyTime = timeRe ? timeRe.test(modalText) : modalText.includes(classTimeNorm);
    }
    const verifyInst = instructorFirstName ? modalText.includes(instructorFirstName) : true;
    console.log(`[cancel] Modal verify — time:${verifyTime} instr:${verifyInst} classTimeNorm:${classTimeNorm}`);

    if (!verifyTime) {
      return { success:false, action:null, message:`The bot found a different class time in the modal — cancelled to avoid removing the wrong booking. Try again or cancel on the YMCA website. (expected: ${classTimeNorm})` };
    }

    // ── Find cancel / unregister / leave-waitlist button ──────────────────────
    const CANCEL_SELECTORS_LIST = [
      'button:has-text("Unregister"), [role="button"]:has-text("Unregister")',
      'button:has-text("Leave Waitlist"), [role="button"]:has-text("Leave Waitlist")',
      'button:has-text("Cancel Waitlist"), [role="button"]:has-text("Cancel Waitlist")',
      'button:has-text("Cancel Registration"), [role="button"]:has-text("Cancel Registration")',
      'button:has-text("Cancel"), [role="button"]:has-text("Cancel")',
    ];

    let cancelBtn = null;
    let cancelLabel = null;
    for (const sel of CANCEL_SELECTORS_LIST) {
      const loc = page.locator(sel);
      if ((await loc.count()) > 0) {
        cancelBtn   = loc.first();
        cancelLabel = (await cancelBtn.textContent().catch(()=>'Cancel')).trim();
        break;
      }
    }

    const allBtnTexts = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(()=>[]);
    console.log(`[cancel] Visible buttons: ${JSON.stringify(allBtnTexts)}`);

    if (!cancelBtn) {
      // ── Stale-state detection (Stage 1: button inspection) ──────────────────
      // No cancel/unregister/leave-waitlist button found in the modal.
      const enrolledElsewhere = allBtnTexts.some(t => /^(register|join waitlist|waitlist)$/i.test(t.trim()));
      const noEnrollmentSignal = allBtnTexts.length === 0 ||
        allBtnTexts.every(t => !/unregister|cancel.*reg|leave waitlist/i.test(t));
      const isStaleByButtons = enrolledElsewhere || noEnrollmentSignal;
      console.log(`[cancel] No cancel btn — staleByButtons:${isStaleByButtons} enrolledElsewhere:${enrolledElsewhere}`);

      // ── Stage 2: quick re-check for ambiguous cases ─────────────────────────
      // If buttons gave us a clear signal (Register visible), trust it and skip re-check.
      // For ambiguous cases (no buttons, or mixed signals), re-probe from the schedule.
      let recheck = null;
      if (!enrolledElsewhere) {
        recheck = await quickRecheckEnrollment(page);
        console.log('[cancel] Re-check result:', JSON.stringify(recheck));
      }

      const confirmedCleared = enrolledElsewhere || (recheck && recheck.enrolled === false) || (recheck && !recheck.found);
      const isStaleState = confirmedCleared || isStaleByButtons;

      return {
        success:    false,
        action:     isStaleState ? 'stale_state' : null,
        staleState: isStaleState,
        recheck,
        message:    confirmedCleared
          ? `Enrollment already cleared on YMCA — no cancel button present` + (recheck ? ` (re-check: ${recheck.reason})` : ' (Register visible)')
          : `No cancel/unregister button found in modal. Visible buttons: ${allBtnTexts.join(', ')}`,
      };
    }

    const isWaitlistCancel = /waitlist/i.test(cancelLabel);
    console.log(`[cancel] Clicking "${cancelLabel}"...`);
    await cancelBtn.click({ timeout:5000 });

    // Wait for a post-cancel state change: confirmation dialog OR success signals.
    // Use waitForSelector to bail out as soon as something appears rather than sleeping.
    const postCancelSig = [
      'button:has-text("Yes")', '[role="button"]:has-text("Yes")',
      'button:has-text("Confirm")', '[role="button"]:has-text("Confirm")',
      'button:has-text("OK")', '[role="button"]:has-text("OK")',
      'button:has-text("Register")', '[role="button"]:has-text("Register")',
      'button:has-text("Waitlist")', '[role="button"]:has-text("Waitlist")',
    ].join(', ');
    await page.waitForSelector(postCancelSig, { timeout:4000 }).catch(()=>null);
    await page.waitForTimeout(300);

    // ── Confirmation dialog: accept if present ────────────────────────────────
    const confirmSels = [
      'button:has-text("Yes"), button:has-text("Confirm"), button:has-text("OK")',
      '[role="button"]:has-text("Yes"), [role="button"]:has-text("Confirm"), [role="button"]:has-text("OK")',
    ];
    for (const sel of confirmSels) {
      const loc = page.locator(sel);
      if ((await loc.count()) > 0) {
        console.log('[cancel] Confirmation dialog detected — clicking confirm...');
        await loc.first().click({ timeout:3000 }).catch(()=>{});
        // Wait for the dialog to close + success signal
        await page.waitForTimeout(800);
        break;
      }
    }

    // ── Verify success: Register or Join Waitlist button should reappear ──────
    await page.waitForTimeout(500);
    const postBtns = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(()=>[]);
    console.log(`[cancel] Post-cancel buttons: ${JSON.stringify(postBtns)}`);

    const registerReturned = postBtns.some(t => /register|reserve|join waitlist|waitlist/i.test(t));
    const cancelGone       = !postBtns.some(t => /unregister|leave waitlist|cancel registration/i.test(t));

    if (registerReturned || cancelGone) {
      const action = isWaitlistCancel ? 'left_waitlist' : 'cancelled';
      const message = isWaitlistCancel ? 'Successfully left the waitlist' : 'Registration cancelled successfully';
      console.log(`✅ [cancel] ${message}`);

      // Save fresh cookies
      try { await saveCookies(page); } catch {}

      return { success:true, action, message };
    }

    // Ambiguous — cancel button may still be present
    return {
      success: false,
      action:  null,
      message: `Cancel clicked but outcome unclear. Post-cancel buttons: ${postBtns.join(', ')}`,
    };

  } catch (err) {
    console.error('[cancel] Unexpected error:', err.message);
    return { success:false, action:null, message: err.message || 'Unexpected error during cancel' };
  } finally {
    if (browser) await browser.close().catch(()=>{});
    if (_authLockAcquired) releaseLock();
  }
}

module.exports = { runBookingJob, cancelRegistration, clickWaitlistReserveConfirmation };

// Allow direct invocation: node src/bot/register-pilates.js
if (require.main === module) {
  runBookingJob({ classTitle: 'Core Pilates' }).then(result => {
    console.log(result.message);
    if (result.screenshotPath) console.log('Screenshot:', result.screenshotPath);
    if (result.status !== 'success') process.exit(1);
  });
}
