// Bot entry point — run by GitHub Actions every Sunday at 2:45 PM UTC.
// Logs into Daxko, finds the Wednesday Core Pilates class with Stephanie
// Sanders, and registers (or joins the waitlist). Set DRY_RUN=1 to run
// with a visible browser without clicking Register/Waitlist.
const fs   = require('fs');
const path = require('path');
const { captureFailureScreenshot, screenshotRelPath } = require('./screenshot-capture');
const { createSession }  = require('./daxko-session');
const { getBookingWindow } = require('../scheduler/booking-window');
const { recordFailure }  = require('../db/failures');
const {
  createRunState, advance, recordTiming, emitEvent, emitSuccess, saveState,
} = require('./sniper-readiness');
const { saveStatus: saveSessionStatus } = require('./session-check');
const { acquireLock, releaseLock, isLocked } = require('./auth-lock');
const { updateAuthState } = require('./auth-state');
const { saveCookies, pingSessionHttp } = require('./session-ping');
const replayStore = require('./replay-store');
const { mergeAndSaveEntries } = require('../classifier/scheduleCache');

// ── Session-file helpers ──────────────────────────────────────────────────────
// Write to familyworks-session.json from the booking/preflight pipeline so that
// FamilyWorks readiness is always up-to-date after every run.
const _DATA_DIR = path.resolve(__dirname, '../data');
const _FW_FILE  = path.join(_DATA_DIR, 'familyworks-session.json');
function _saveFwStatus(status) {
  try {
    if (!fs.existsSync(_DATA_DIR)) fs.mkdirSync(_DATA_DIR, { recursive: true });
    fs.writeFileSync(_FW_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.warn('[register-pilates] saveFwStatus failed:', e.message);
  }
}

// Maps modal-verification reasonTag → structured failure reason code.
const REASONTAG_TO_REASON = {
  'time':            'modal_time_mismatch',
  'instructor':      'modal_instructor_mismatch',
  'time-instructor': 'modal_mismatch',
  'error':           'unexpected_error',
};

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

// Detects which action buttons are present in the current page state.
// Tries each selector strategy in order; stops at first match.
// Returns:
//   { hasRegister, hasWaitlist, hasCancel, hasLoginRequired,
//     registerBtn, waitlistBtn, cancelBtn, allBtnTexts,
//     registerStrategy, waitlistStrategy }
async function detectActionButtons(page) {
  const allBtnTexts = await page.locator(ACTION_SELECTORS.allVisible).allTextContents().catch(() => []);

  let registerBtn = null;
  let registerStrategy = 'not found';
  for (const [sel, label] of ACTION_SELECTORS.register) {
    const loc = page.locator(sel);
    if ((await loc.count()) > 0) {
      registerBtn      = loc;
      registerStrategy = label;
      break;
    }
  }

  let waitlistBtn = null;
  let waitlistStrategy = 'not found';
  for (const [sel, label] of ACTION_SELECTORS.waitlist) {
    const loc = page.locator(sel);
    if ((await loc.count()) > 0) {
      waitlistBtn      = loc;
      waitlistStrategy = label;
      break;
    }
  }

  // "Cancel" button appearing after a click means the booking completed successfully.
  let cancelBtn = null;
  for (const [sel] of ACTION_SELECTORS.cancel) {
    const loc = page.locator(sel);
    if ((await loc.count()) > 0) {
      cancelBtn = loc;
      break;
    }
  }

  const hasLoginRequired = allBtnTexts.some(t => ACTION_SELECTORS.loginRequired.test(t));
  const hasRegister = registerBtn !== null;
  const hasWaitlist = waitlistBtn !== null;
  const hasCancel   = cancelBtn   !== null;

  console.log(`[action-detect] register: ${registerStrategy} | waitlist: ${waitlistStrategy} | cancel: ${hasCancel ? 'found' : 'not found'}`);

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
  return 'unknown';
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
  await page.waitForTimeout(2000);

  async function readSignals() {
    const btns = await detectActionButtons(page);
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    // Match explicit server-side confirmations. Includes FamilyWorks waitlist phrases.
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
    await page.waitForTimeout(2000);

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
  // wait an extra 3 s and re-check before falling back to the weak buttons-gone signal.
  if (!step1.btns.hasRegister && !step1.btns.hasWaitlist) {
    console.log(`[confirm-check] buttons gone — waiting 3 s for delayed Cancel/text confirmation...`);
    await page.waitForTimeout(3000);
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

// Set to false to skip visual highlights in production.
// When true, the bot outlines the click target in the live browser and
// appends a floating "CLICK TARGET" label — both visible in screenshots.
const DEBUG_HIGHLIGHT = true;

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

  // ── Timing capture — filled in during the sniper poll and action phases ──────
  // Written to _state.timing at the end of the run so it persists to the UI.
  const _tc = {
    bookingOpenAt:        null, // ISO: when booking window was scheduled to open
    cardFoundAt:          null, // ISO: when the class card appeared after open
    actionClickAt:        null, // ISO: when Register/Waitlist was actually clicked
    pollAttemptsPostOpen: 0,    // tab re-clicks that happened at or after open time
  };

  // Convert "Wednesday" → "Wed" to match tab labels like "Wed 02"
  const DAY_SHORT = {
    Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
    Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat',
  };
  let dayShort = DAY_SHORT[dayOfWeek] || 'Wed';

  // If targetDate is provided (YYYY-MM-DD), derive the exact day number and
  // override dayShort from the date itself (more reliable than the DB string).
  let targetDayNum = null;
  if (targetDate) {
    const d = new Date(targetDate + 'T00:00:00Z'); // parse as UTC to avoid tz shift
    dayShort     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    targetDayNum = d.getUTCDate(); // numeric day-of-month, e.g. 9
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

  // logRunSummary — defined before the try block so it is in scope for both
  // the try body and the catch handler.  Returns `result` so it can be inlined:
  //   return logRunSummary({ status: '...', message: '...', screenshotPath });
  function logRunSummary(result) {
    // Attach the run-level screenshot ref to the persisted state so UI can access it.
    const _ref = _screenshotRef(screenshotPath);
    if (_ref) _state.screenshotPath = _ref;

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
      _pingResult   = await pingSessionHttp();
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
      _session = await createSession({ headless: isHeadless });
      // Auth succeeded — update session-status.json so the UI reflects the fresh result.
      saveSessionStatus({
        valid:     true,
        checkedAt: new Date().toISOString(),
        source:    _runSource,
        detail:    'Daxko login succeeded',
        screenshot: null,
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
      emitEvent(_state, 'AUTH', 'AUTH_LOGIN_FAILED', loginErr.message, {
        screenshot: loginErr.screenshotPath ? path.basename(loginErr.screenshotPath) : null,
        evidence: {
          provider: 'Daxko',
          detail:   (loginErr.message || 'Login failed').slice(0, 120),
        }
      });
      return logRunSummary({ status: 'error', message: loginErr.message, screenshotPath, phase: 'auth', reason: 'login_failed', category: 'auth', label: 'Daxko login failed' });
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
    const snap = async (label = '') => {
      const p = await _session.snap(label);
      if (p) screenshotPath = p;
    };
    // Structured failure capture — saves to data/screenshots/{date}/{jobId}_{phase}_{reason}_{ts}.png
    // and updates screenshotPath so logRunSummary / recordFailure pick it up.
    const captureFailure = async (phase, reason) => {
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

    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout: 60000 });
    await page.waitForLoadState('networkidle');
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

    // Log all selects and their options so we can see what filters are available.
    const allSelectInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map((sel, i) => ({
        index: i,
        options: Array.from(sel.options).map(o => o.text),
      }));
    });
    console.log('Available select dropdowns:', JSON.stringify(allSelectInfo));

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
        await page.waitForTimeout(1000);
        const newCount = await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            const m = el.textContent.match(/(\d+)\s+class(?:es)?\s+this\s+week/i);
            if (m && el.children.length === 0) return parseInt(m[1], 10);
          }
          return null;
        });
        console.log(`  Native selectOption for "${targetValue}": class count ${initialCount} → ${newCount}`);
        if (newCount !== null && newCount !== initialCount) {
          console.log(`✅ Filter #${selectIndex} (${filterLabel}) applied via native select — count changed!`);
          return true;
        }
        // Native selectOption did not change the class count → filter had no effect.
      // Do NOT fall back to pill click: in headless mode, opening the Bubble.io custom
      // dropdown without completing a selection leaves it in a partially-applied state
      // that corrupts subsequent filter attempts (observed: count dropped from 79→14
      // when pill was clicked but option was never selected).
      console.log(`  Native selectOption did not change class count — skipping pill click to avoid state corruption.`);
      return false;
    } catch (nse) {
      console.log(`  Native selectOption threw: ${nse.message} — skipping pill click to avoid state corruption.`);
      return false;
    }
    // (pill-click approach removed: Bubble.io custom dropdowns never open in headless mode
    //  and partial clicks corrupt the filter state)
  }

    // Filter strategy: Category (index 0) + Instructor (index 2) via native selectOption.
    // Event Name filter (index 3) is intentionally skipped: its native selectOption fails
    // ("did not find some options") and the pill-click fallback corrupts Bubble.io state
    // by partially opening the dropdown (observed: count went 79→14 from an aborted click).
    const categoryApplied = await applyFilterBySelectIndex(0, 'Yoga/Pilates', 'Category');

    // Resolve instructor filter value: the DB may store just a first name (e.g. "Gretl")
    // or a full name (e.g. "Stephanie Sanders").  Find the best match from the dropdown
    // so selectOption() can do an exact-text match against the option element.
    let instructorForFilter = null;
    if (instructor) {
      const instrDropdown = allSelectInfo.find(s => s.index === 2);
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
    const instructorApplied = instructorForFilter
      ? await applyFilterBySelectIndex(2, instructorForFilter, 'Instructor')
      : false;

    if (!categoryApplied)   console.log('⚠️ Category filter not applied — will scan all categories.');
    if (!instructorApplied) console.log('⚠️ Instructor filter not applied — will scan all instructors.');

    // ── POINT 2: navigate — filter application failure ────────────────────────
    if (!categoryApplied && !instructorApplied) {
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
      console.log('⚠️ Schedule appears empty (0 time-bearing card-sized rows) — possible render failure.');
      await captureFailure('navigate', 'schedule_not_rendered');
      recordFailure({
        jobId:    job.id || job.jobId || null,
        phase:    'navigate', reason: 'schedule_not_rendered',
        category: 'navigate', label: 'Schedule rendered 0 rows after filter',
        message:  'No time-containing card-sized elements visible after filter application',
        classTitle,
        screenshot: _screenshotRef(screenshotPath),
        url:      page.url(),
        context:  { categoryApplied, instructorApplied },
      });
      // Non-terminal — continue; tab click may trigger re-render.
    }
    // ─────────────────────────────────────────────────────────────────────────

    advance(_state, 'DISCOVERY');
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

          const desc = el.querySelectorAll('*').length;
          // 100-desc cap: excludes page wrappers, filter dropdowns (~200+ desc),
          // and repeating-group containers, while keeping individual class cards (~20-50 desc).
          if (desc > 100) continue;
          if (desc < 2)   continue;   // skip bare text wrappers / leaf nodes

          const raw  = el.textContent || '';
          const txt  = norm(raw);
          if (!txt) continue;

          const hasTime  = timeAmRe.test(txt);
          const hasTitle = titleRe.test(txt);
          const hasInstr = instrRe.test(txt);

          // Collect all card-sized nodes for diagnostic logging
          const r = el.getBoundingClientRect();
          // Skip truly hidden elements (display:none / collapsed to 0×0).
          // Bubble.io's virtual repeating-group recycles DOM nodes: when you switch
          // date tabs, old entries get hidden (width=0, height=0) but keep their
          // previous text content.  Scoring these stale nodes leads to clicking
          // invisible elements and crashing the booking attempt.
          if (r.width === 0 && r.height === 0) continue;
          const looks_card = r.width >= 100 && r.height >= 30;
          if (looks_card && (hasTitle || hasTime || hasInstr)) {
            allTexts.push({ desc, txt: txt.slice(0, 150), hasTime, hasTitle, hasInstr });
          }

          if (!hasTitle && !hasTime && !hasInstr) continue;

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

          allRows.push({
            el,
            score,
            reasons,
            desc,
            visible: looks_card,
            txt: txt.slice(0, 200),
          });
        }

        // Sort: highest score first; prefer visible (looks_card) within same score;
        // tie-break on fewest descendants (most specific element).
        allRows.sort((a, b) =>
          b.score - a.score ||
          (b.visible ? 1 : 0) - (a.visible ? 1 : 0) ||
          a.desc - b.desc
        );

        if (allRows.length === 0) return { matched: null, allResults: [], allTexts };

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
      return page.locator('[data-target-class="yes"]').first();
    }

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
        return;
      }

      // INCREMENTAL: use page.mouse.wheel() so Bubble.io fires scroll/virtual-scroll events.
      // First, move mouse to centre of the schedule panel to make sure the wheel targets it.
      const center = await page.evaluate(() => {
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
      await page.waitForTimeout(1000); // let the tab panel settle

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
      console.log(`  Phase 1: scrolling UP ${MAX_UP} steps to find AM class above current position...`);
      for (let step = 0; step < MAX_UP; step++) {
        await scrollSchedulePanel(-STEP_PX);
        await page.waitForTimeout(200);
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
      await page.waitForTimeout(200);

      for (let step = 0; step < MAX_DOWN; step++) {
        await scrollSchedulePanel(STEP_PX);
        await page.waitForTimeout(200);
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
          await page.waitForTimeout(1000); // let tab render

          // Check if we're close to the booking window opening.
          // If so, skip the 90-second scroll scan — we'll enter poll mode shortly anyway.
          let nearOpen = false;
          try {
            const { bookingOpen: bwChk } = getBookingWindow(job);
            nearOpen = bwChk && (bwChk.getTime() - Date.now()) < 15 * 60 * 1000;
          } catch { /* ignore */ }

          if (nearOpen) {
            // Quick scan only — polling will handle the precise timing
            targetCard = await findTargetCard();
            if (targetCard) console.log('Found class on exact date tab (quick scan): ' + tabText.trim());
            else            console.log('Class not yet visible (within 15 min of open) — going to poll mode.');
          } else {
            targetCard = await findCardOnTab(tabText.trim());
            if (targetCard) console.log('Found class on exact date tab: ' + tabText.trim());
            else            console.log('Class not on exact date tab — will try polling if within booking window.');
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
    // Skip if we're within the poll window — the booking window is about to open
    // and slow scroll scans (230 steps × 400 ms ≈ 90 s per tab) just waste time
    // when polling will start in moments anyway.
    if (!targetCard) {
      let skipFallback = false;
      try {
        const { bookingOpen: bwCheck } = getBookingWindow(job);
        if (bwCheck && (bwCheck.getTime() - Date.now()) < 15 * 60 * 1000) {
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
          if (targetCard) { console.log('Found class on ' + tabText.trim()); break; }
          console.log('Class not found on ' + tabText.trim() + ', trying next tab...');
        }
      }
    }

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
          await page.waitForTimeout(1000); // let Bubble.io re-render
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
      const msg = `Could not find visible row matching ${classTitle} / ${classTimeNorm || classTime} / ${instructor || 'Stephanie'} on ${dayShort} ${targetDayNum || '(any)'}.`;
      console.log(msg);
      await captureFailure('scan', 'class_not_found');
      const _topSignals = (_lastAllTexts || []).slice(0, 3).map(r => r.txt.slice(0, 60)).join(' | ');
      emitFailure('DISCOVERY', 'DISCOVERY_EMPTY', msg, {
        evidence: { ...(_topSignals ? { nearMisses: _topSignals } : {}) }
      });
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
      try {
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
          // Element was detached — Bubble re-rendered between findTargetCard() and here.
          return { ok: false, failMsg: 'Card element detached after Bubble.io DOM re-render (attribute lost)', reasonTag: 'error', recorded: false };
        }

        // Step 1: prefer button / [role="button"] / <a> inside the card
        const clickable    = card.locator("button, [role='button'], a").first();
        const hasClickable = (await clickable.count()) > 0;

        let clickTarget, clickDesc;
        if (hasClickable) {
          clickTarget = clickable;
          clickDesc   = 'button/[role=button]/a child';
        } else {
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
        try {
          await clickTarget.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await clickTarget.click({ timeout: 5000 });
        } catch (clickErr) {
          console.log(`⚠️ Normal click failed (${candidateLabel}), force-clicking:`, clickErr.message.split('\n')[0]);
          // ── Capture before emitting so screenshot ref is attached to event ─
          await captureFailure('click', 'fallback_used');
          emitFailure('ACTION', 'ACTION_FORCE_CLICK_USED', `Normal click failed — force-click fallback (${candidateLabel})`);
          // ─────────────────────────────────────────────────────────────────
          // ── POINT 5: click — fallback to force click ──────────────────────
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'click', reason: 'click_fallback',
            category: 'click', label: 'Normal click failed — using force click',
            message:  clickErr.message.split('\n')[0],
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  { candidateLabel, clickDesc },
          });
          // ─────────────────────────────────────────────────────────────────
          await card.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await card.click({ force: true });
        }
        // Clean up the data-click-target attribute now that the click is done.
        await page.evaluate(() =>
          document.querySelectorAll('[data-click-target]').forEach(e => e.removeAttribute('data-click-target'))
        ).catch(() => {});

        // Signal-driven modal wait: resolve as soon as action buttons appear
        // (capped at 3 s). Falls back gracefully — we proceed regardless.
        // Replaces the blunt waitForTimeout(2000) to catch fast modal renders early.
        await page.waitForSelector(ACTION_SELECTORS.modalReady, { timeout: 3000 }).catch(() => null);
        // Small settle buffer so the modal text is fully populated.
        await page.waitForTimeout(300);
        await captureDebug('modal', 'modal_opened');

        // Verify the modal matches expected time + instructor.
        // Normalize all whitespace variants (Bubble.io uses \u00A0 in time strings).
        const rawModal  = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
        const modalText = rawModal.replace(/[\u00A0\u2009\u202f]+/g, ' ');
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
        console.log(`Modal verification (${candidateLabel}) —`, JSON.stringify({ verifyTime, verifyInst, classTimeNorm, instructorFirstName }));

        // Time mismatch = definitive fail (we clicked the wrong class / window not open yet).
        // Instructor mismatch only = soft warning — instructor may be a substitute this week;
        // class title + time match is sufficient to confirm identity, so we proceed.
        if (!verifyTime) {
          const reasonTag   = verifyInst ? 'time' : 'time-instructor';
          const reasonLabel = { 'time': 'Time mismatch', 'time-instructor': 'Time + Instructor mismatch' }[reasonTag] || 'Time mismatch';
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
          return { ok: false, failMsg, reasonTag, recorded: true };
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
        return { ok: true };

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
        return { ok: false, failMsg, reasonTag: 'error', recorded: true };
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
    const isTimeMismatch = r => r.reasonTag === 'time' || r.reasonTag === 'time-instructor';

    // Row-capacity bail: if the schedule row already showed "full" or "waitlist"
    // in its text content, clicking the card will either time out (full cards
    // have no interactive register button) or open a modal we cannot act on.
    // Return the correct status immediately rather than hanging for 30 s.
    if (_rowCapacityFromSchedule === 'full') {
      console.log('[row-capacity] Bailing out before click — schedule row shows class is full');
      await captureFailure('action', 'class_full');
      return logRunSummary({
        status: 'full',
        message: 'Class is full (schedule row indicator — no register button present)',
        screenshotPath,
        phase:    'action',
        reason:   'class_full',
        category: 'availability',
        label:    'Class full',
      });
    }
    if (_rowCapacityFromSchedule === 'waitlist') {
      console.log('[row-capacity] Bailing out before click — schedule row shows waitlist only');
      return logRunSummary({
        status:   'waitlist_only',
        message:  'Class is full — waitlist shown on schedule row',
        screenshotPath,
        phase:    'action',
        reason:   'class_full',
        category: 'availability',
      });
    }

    const firstResult = await attemptClickAndVerify(targetCard, 'best candidate');

    if (!firstResult.ok) {
      // Decide whether to try the second-best fallback
      const secondQualifies = _lastSecondCard && _lastSecondScore >= CONFIDENCE_THRESHOLD - 2;

      if (secondQualifies) {
        console.log(`⚠️ Best match failed verification, trying second-best candidate once`);
        console.log(`   Best score: ${_lastBestScore} | Selected row: "${_lastBestText.slice(0, 100)}"`);
        console.log(`   Second-best score: ${_lastSecondScore} | Row: "${_lastSecondText.slice(0, 100)}"`);

        // Dismiss the current modal before clicking a different card
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1200);

        const secondResult = await attemptClickAndVerify(_lastSecondCard, 'second-best candidate');
        if (!secondResult.ok) {
          // Both candidates had the wrong time → target class is not on the schedule
          if (isTimeMismatch(secondResult)) {
            const msg = `Target class not found: all candidates showed wrong time. "${classTitle}" at ${classTimeNorm} is not on the schedule yet.`;
            console.log(`ℹ️  ${msg}`);
            await captureFailure('scan', 'class_not_found');
            return logRunSummary({ status: 'not_found', message: msg, screenshotPath, phase: 'scan', reason: 'class_not_found', category: 'scan', label: 'All candidates showed wrong time', url: page.url() });
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
        // Time mismatch with no fallback → target class absent from schedule
        if (isTimeMismatch(firstResult)) {
          const msg = `Target class not found: best candidate showed wrong time. "${classTitle}" at ${classTimeNorm} is not on the schedule yet.`;
          console.log(`ℹ️  ${msg}`);
          await captureFailure('scan', 'class_not_found');
          return logRunSummary({ status: 'not_found', message: msg, screenshotPath, phase: 'scan', reason: 'class_not_found', category: 'scan', label: 'Best candidate showed wrong time', url: page.url() });
        }
        // Verify failure already recorded inline in attemptClickAndVerify
        return logRunSummary({ status: 'error', message: firstResult.failMsg, screenshotPath, phase: 'verify', reason: REASONTAG_TO_REASON[firstResult.reasonTag] || 'unexpected_error', recorded: firstResult.recorded });
      }
    }

    // Step 5: Try to register — retry every 30s for up to 10 minutes if not open yet.
    // maxAttemptsOpt can be passed in job object (e.g. 1 for web UI, 20 for cron).
    advance(_state, 'ACTION');
    const maxAttempts = maxAttemptsOpt || 20;
    let registered = false;

    // ── PREFLIGHT GATE ─────────────────────────────────────────────────────────
    // When preflightOnly is set, check readiness of the booking action without
    // actually clicking Register/Waitlist.  Returns immediately after sniffing
    // which buttons are present in the already-open modal.
    if (PREFLIGHT_ONLY) {
      const { hasRegister, hasWaitlist, hasLoginRequired: hasLoginBtn, registerBtn, waitlistBtn, allBtnTexts, registerStrategy, waitlistStrategy } = await detectActionButtons(page);
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
          return logRunSummary({ status: 'found_not_open_yet', message: _notOpenMsg, screenshotPath });
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let { hasRegister, hasWaitlist, hasCancel: hasCancelNow, hasLoginRequired: hasLoginButton,
            registerBtn, waitlistBtn, cancelBtn, allBtnTexts: allBtns,
            registerStrategy, waitlistStrategy } = await detectActionButtons(page);

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
          const recheck = await detectActionButtons(page);
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
          await registerBtn.first().click();
          _state.isConfirming = true; saveState(_state);
          const wlResult2 = await checkBookingConfirmed(page, _jobId, attempt, 'Register(full→waitlist)', replayStore);
          _state.isConfirming = false;
          if (wlResult2.confirmed) {
            replayStore.addEvent(_jobId, 'confirm', `Waitlist enrollment confirmed (via Register button${wlResult2.viaPopup ? ' + popup' : ''}) — Cancel button: ${wlResult2.cancelFound}`);
            console.log(`WAITLIST: Class full — joined waitlist for ${classTitle} ${classTimeNorm || classTime}`);
            registered = true;
            break;
          } else {
            console.log('⚠️ Post-waitlist (via Register): booking did not complete. Retrying...');
            await captureFailure('post_click', 'result_unknown');
            // Preserve _replayAction='waitlist' if weak signal fired — re-open modal
            // may find Cancel confirming the waitlist join happened.
            if (!wlResult2.weakSignal) _replayAction = null;
            await page.waitForTimeout(3000);
            continue;
          }
        }
        // ─────────────────────────────────────────────────────────────────
        _replayAction = 'register';
        replayStore.addEvent(_jobId, 'action_attempt', 'Clicked Register', `Attempt ${attempt}`);
        _tc.actionClickAt = new Date().toISOString();
        await registerBtn.first().click();
        _state.isConfirming = true; saveState(_state);
        const regResult = await checkBookingConfirmed(page, _jobId, attempt, 'Register', replayStore);
        _state.isConfirming = false;

        if (!regResult.confirmed) {
          // Booking genuinely did not complete — record the failure and retry next attempt.
          await captureFailure('post_click', 'result_unknown');
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'post_click', reason: 'registration_unclear',
            category: 'post_click', label: 'No confirmation after Register click',
            message:  'Register button clicked but booking not confirmed (no Cancel button appeared, no action buttons changed)',
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  { attempt, viaPopup: regResult.viaPopup },
          });
          await page.waitForTimeout(3000);
          continue;  // retry this attempt
        }
        // ─────────────────────────────────────────────────────────────────
        console.log(`SUCCESS: Registered for ${classTitle} ${classTimeNorm || classTime} with ${instructor || 'Stephanie'} (cancelFound=${regResult.cancelFound}, viaPopup=${regResult.viaPopup})`);
        replayStore.addEvent(_jobId, 'confirm', `Registration confirmed — Cancel button: ${regResult.cancelFound}`);
        registered = true;
        break;
      } else if (hasWaitlist) {
        if (DRY_RUN) {
          console.log('DRY RUN: Would click Waitlist button. Done.');
          registered = true;
          break;
        }
        _replayAction = 'waitlist';
        replayStore.addEvent(_jobId, 'action_attempt', 'Clicked Join Waitlist', `Attempt ${attempt}`);
        _tc.actionClickAt = new Date().toISOString();
        await waitlistBtn.first().click();
        _state.isConfirming = true; saveState(_state);
        const wlResult = await checkBookingConfirmed(page, _jobId, attempt, 'Waitlist', replayStore);
        _state.isConfirming = false;
        if (wlResult.confirmed) {
          replayStore.addEvent(_jobId, 'confirm', `Waitlist enrollment confirmed (cancelFound=${wlResult.cancelFound}, viaPopup=${wlResult.viaPopup})`);
          console.log(`WAITLIST: Joined waitlist for ${classTitle} ${classTimeNorm || classTime}`);
          registered = true;
          break;
        } else {
          console.log('⚠️ Post-waitlist: booking did not complete. Retrying...');
          await captureFailure('post_click', 'result_unknown');
          recordFailure({
            jobId:    job.id || job.jobId || null,
            phase:    'post_click', reason: 'registration_unclear',
            category: 'post_click', label: 'No confirmation after Waitlist click',
            message:  'Waitlist button clicked but booking not confirmed (no Cancel button appeared)',
            classTitle,
            screenshot: _screenshotRef(screenshotPath),
            url:      page.url(),
            context:  { attempt, viaPopup: wlResult.viaPopup, weakSignal: !!wlResult.weakSignal },
          });
          // Preserve _replayAction='waitlist' if weak signal fired — re-open modal
          // may find Cancel confirming the waitlist join happened.
          if (!wlResult.weakSignal) _replayAction = null;
          await page.waitForTimeout(3000);
          continue;
        }
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
            const msg = `Class found on schedule (${classDesc}). Registration is not open yet. Bot will retry during booking window.`;
            console.log('ℹ️  ' + msg);
            await captureFailure('gate', 'uncertain_state');
            // ── POINT 4: gate — early exit (booking window far off) ────────
            recordFailure({
              jobId:    job.id || job.jobId || null,
              phase:    'gate', reason: 'booking_not_open',
              category: 'gate', label: 'Registration not open — exiting early for scheduler retry',
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
        await page.waitForLoadState('networkidle');
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
              await clickableRetry.click();
            } else {
              await targetCard.click();
            }
          } catch (retryErr) {
            console.log('⚠️ Retry click fallback:', retryErr.message);
            if (hasClickableRetry) {
              await clickableRetry.click({ force: true });
            } else {
              await targetCard.click({ force: true });
            }
          }
        }
        await page.waitForTimeout(2000);
      }
    }

    if (!registered) {
      const classDesc = [
        classTitle,
        `${dayShort}${targetDayNum ? ' ' + targetDayNum : ''}`,
        classTimeNorm || classTime,
        instructor || 'Stephanie',
      ].join(' · ');
      const msg = `Class found on schedule (${classDesc}). Registration did not open within the retry window.`;
      console.log('ℹ️  ' + msg);
      await captureFailure('gate', 'uncertain_state');
      // ── POINT 4: gate — exhausted retry window ─────────────────────────
      recordFailure({
        jobId:    job.id || job.jobId || null,
        phase:    'gate', reason: 'booking_not_open',
        category: 'gate', label: 'Registration did not open within retry window',
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
        replayStore.addEvent(_jobId, 'waitlist', 'Joined waitlist', classTitle);
      } else {
        replayStore.addEvent(_jobId, 'success', 'Booking confirmed', classTitle);
      }
    }
    emitSuccess(_state);
    _saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt: new Date().toISOString(), source: 'booking', detail: 'Booking completed successfully — FamilyWorks session confirmed active' });
    return logRunSummary({ status: _replayAction === 'waitlist' ? 'waitlist' : 'booked', message: successMsg, screenshotPath });

  } catch (err) {
    console.error('❌ Error:', err.message);
    if (!PREFLIGHT_ONLY) replayStore.addEvent(_jobId, 'failure', 'Booking failed', err.message.split('\n')[0]);
    return logRunSummary({ status: 'error', message: err.message, screenshotPath, phase: 'system', reason: 'unexpected_error', category: 'system', label: 'Unhandled exception in booking job' });
  } finally {
    // ── Compute and persist timing deltas ────────────────────────────────────
    if (_tc.bookingOpenAt) {
      const openMs = new Date(_tc.bookingOpenAt).getTime();
      recordTiming(_state, {
        bookingOpenAt:        _tc.bookingOpenAt,
        cardFoundAt:          _tc.cardFoundAt,
        actionClickAt:        _tc.actionClickAt,
        openToCardMs:         _tc.cardFoundAt   ? (new Date(_tc.cardFoundAt).getTime()   - openMs) : null,
        openToClickMs:        _tc.actionClickAt ? (new Date(_tc.actionClickAt).getTime() - openMs) : null,
        pollAttemptsPostOpen: _tc.pollAttemptsPostOpen,
      });
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

module.exports = { runBookingJob, cancelRegistration };

// Allow direct invocation: node src/bot/register-pilates.js
if (require.main === module) {
  runBookingJob({ classTitle: 'Core Pilates' }).then(result => {
    console.log(result.message);
    if (result.screenshotPath) console.log('Screenshot:', result.screenshotPath);
    if (result.status !== 'success') process.exit(1);
  });
}
