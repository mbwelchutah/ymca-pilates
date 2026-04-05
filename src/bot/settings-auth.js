// Settings-triggered login flow.
// Called explicitly by the user via Settings > Log in now.
//
// Flow:
//   1. Daxko login via createSession() — also attempts FamilyWorks SSO inside
//   2. Navigate to the FamilyWorks schedule embed
//   3. Click any visible class card to open a booking modal
//   4. Check modal button: "Register" (session OK) vs "Login to Register" (missing)
//   5. If "Login to Register" → click it (triggers Daxko OAuth) → navigate back → re-check once
//   6. Persist results to session-status.json (Daxko) and familyworks-session.json (FW)
//
// Logging prefixes:
//   [settings-auth]    — Daxko login phase
//   [settings-session] — FamilyWorks verification phase

const fs   = require('fs');
const path = require('path');
const { createSession } = require('./daxko-session');

const DATA_DIR   = path.resolve(__dirname, '../data');
const DAXKO_FILE = path.join(DATA_DIR, 'session-status.json');
const FW_FILE    = path.join(DATA_DIR, 'familyworks-session.json');

const SCHEDULE_URL = 'https://my.familyworks.app/schedulesembed/eugeneymca?search=yes';

// ── Persistence helpers ───────────────────────────────────────────────────────

function saveDaxkoStatus(status) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DAXKO_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.warn('[settings-auth] saveDaxkoStatus failed:', e.message);
  }
}

function saveFwStatus(status) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FW_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.warn('[settings-session] saveFwStatus failed:', e.message);
  }
}

function loadFwStatus() {
  try {
    if (!fs.existsSync(FW_FILE)) return null;
    return JSON.parse(fs.readFileSync(FW_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ── FamilyWorks session verification ─────────────────────────────────────────

/**
 * Navigates to the FamilyWorks schedule embed (already loaded or re-navigated),
 * clicks the first visible class card, and checks the modal button text.
 *
 * Returns:
 *   { ready: true }                          — "Register" button visible
 *   { ready: false, ssoClickDone: true }     — clicked "Login to Register", URL changed
 *   { ready: null,  detail: string }         — couldn't determine (no cards, no button)
 */
async function checkFwModalSession(page, snap, { attempt = 1 } = {}) {
  console.log(`[settings-session] Checking FamilyWorks session via modal (attempt ${attempt})...`);

  // The schedule starts on "Today" which may have no classes (e.g. Saturday/Sunday).
  // Click the first weekday tab (Mon-Fri) to ensure cards are visible.
  // Day tabs appear as text like "Mon 06", "Tue 07", "Wed 08" etc.
  const DAY_TABS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  let tabClicked = false;
  for (const day of DAY_TABS) {
    const tab = page.locator(`text=/${day}\\s+\\d+/i`).first();
    if ((await tab.count()) > 0) {
      try {
        await tab.click({ timeout: 3000 });
        console.log(`[settings-session] Clicked day tab: ${day}`);
        await page.waitForTimeout(3000);
        tabClicked = true;
        break;
      } catch { /* try next day */ }
    }
  }
  if (!tabClicked) {
    console.log('[settings-session] No weekday tab found — continuing on current day view.');
    await page.waitForTimeout(2000);
  }

  // Look for class cards by finding elements whose visible text contains a time
  // range (e.g. "4:20 p - 5:20 p"). We search for leaf-level elements to avoid
  // matching huge wrapper divs that contain multiple cards.
  const cardLocator = page.locator('*').filter({ hasText: /\d:\d+ [ap] - \d+:\d+ [ap]/i });

  // Wait up to 5 s for cards to appear after tab click.
  try {
    await page.waitForFunction(
      () => {
        return [...document.querySelectorAll('*')].some(el => {
          const t = (el.children.length === 0 ? el.textContent : '') || '';
          return /\d:\d+ [ap] - \d+:\d+ [ap]/i.test(t);
        });
      },
      null,
      { timeout: 5000 }
    );
  } catch { /* fallthrough */ }

  const cardCount = await cardLocator.count();
  if (cardCount === 0) {
    console.log('[settings-session] No class cards found on schedule embed.');
    await snap('settings-no-cards');
    return { ready: null, ssoClickDone: false, detail: 'No class cards found on the schedule' };
  }
  console.log(`[settings-session] Found ${cardCount} card-like elements on schedule.`);

  // Try to click a card that is large enough to be a proper class card, not a
  // tiny time-label fragment. Prefer elements with height > 30px.
  let clicked = false;
  for (let i = 0; i < Math.min(cardCount, 12); i++) {
    const el = cardLocator.nth(i);
    try {
      const box = await el.boundingBox();
      if (!box || box.width < 80 || box.height < 30) continue;
      await el.click({ timeout: 3000 });
      clicked = true;
      console.log(`[settings-session] Clicked card element ${i} (${Math.round(box.width)}×${Math.round(box.height)})`);
      break;
    } catch { /* try next */ }
  }

  if (!clicked) {
    console.log('[settings-session] Could not click any class card.');
    return { ready: null, ssoClickDone: false, detail: 'Could not click any class card' };
  }

  // Wait for modal to appear (button with "Register" or "Login to Register").
  await page.waitForTimeout(2500);

  const registerBtn      = page.locator('button, [role="button"], a').filter({ hasText: /^(Register|Reserve)$/i });
  const loginToRegister  = page.locator('button, [role="button"], a').filter({ hasText: /Login to Register/i });

  const hasRegister = await registerBtn.count() > 0;
  const hasLogin    = await loginToRegister.count() > 0;

  if (hasRegister) {
    console.log('[settings-session] Modal shows "Register" — FamilyWorks session active.');
    return { ready: true, ssoClickDone: false, detail: 'FamilyWorks session active — Register button visible' };
  }

  if (hasLogin) {
    console.log('[settings-session] Modal shows "Login to Register" — clicking to trigger SSO...');
    await loginToRegister.first().click();
    await page.waitForTimeout(3500);
    const afterUrl = page.url();
    console.log('[settings-session] After "Login to Register" click, URL:', afterUrl);
    await snap('settings-after-login-to-register');
    return { ready: false, ssoClickDone: true, afterUrl, detail: 'Clicked "Login to Register" — SSO triggered' };
  }

  await snap(`settings-modal-unknown-attempt${attempt}`);
  console.log('[settings-session] Modal opened but no recognized button found.');
  return { ready: null, ssoClickDone: false, detail: 'Modal opened but no recognized button (Register / Login to Register) found' };
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Runs the full "Log in now" sequence triggered from Settings.
 *
 * @param {object} [opts]
 * @param {string} [opts.source='settings']
 * @returns {Promise<{
 *   daxko: 'DAXKO_READY' | 'AUTH_NEEDS_LOGIN',
 *   familyworks: 'FAMILYWORKS_READY' | 'FAMILYWORKS_SESSION_MISSING' | 'AUTH_UNKNOWN',
 *   lastVerified: string,
 *   detail: string,
 *   screenshot: string | null,
 * }>}
 */
async function runSettingsLogin({ source = 'settings' } = {}) {
  const checkedAt = new Date().toISOString();
  let sess = null;

  console.log('[settings-auth] ─────────────────────────────────────');
  console.log('[settings-auth] Starting Settings login flow...');

  try {
    // ── Step 1: Daxko login ───────────────────────────────────────────────
    sess = await createSession({ headless: true });
    console.log('[settings-auth] Daxko login: OK');

    saveDaxkoStatus({
      valid: true,
      checkedAt,
      source,
      detail: 'Login successful via Settings',
      screenshot: null,
    });

    // ── Step 2: Navigate to FamilyWorks schedule embed ────────────────────
    console.log('[settings-session] Navigating to FamilyWorks schedule embed...');
    await sess.page.goto(SCHEDULE_URL, { timeout: 30000 });
    await sess.page.waitForLoadState('networkidle').catch(() => {});
    await sess.page.waitForTimeout(3000);

    // ── Step 3: First modal check ─────────────────────────────────────────
    let fwResult = await checkFwModalSession(sess.page, sess.snap, { attempt: 1 });

    // ── Step 4: SSO retry — if "Login to Register" was clicked, navigate
    //   back and re-verify once. The Daxko account page (MyAccountV2.mvc)
    //   that appears after the click may have completed the OAuth handshake;
    //   returning to the schedule embed confirms whether the session was set.
    if (!fwResult.ready && fwResult.ssoClickDone) {
      console.log('[settings-session] SSO click done — navigating back to verify session...');
      await sess.page.goto(SCHEDULE_URL, { timeout: 30000 });
      await sess.page.waitForLoadState('networkidle').catch(() => {});
      await sess.page.waitForTimeout(3000);
      fwResult = await checkFwModalSession(sess.page, sess.snap, { attempt: 2 });
    }

    // ── Step 5: Map result to FamilyWorks status ──────────────────────────
    let familyworks;
    if (fwResult.ready === true) {
      familyworks = 'FAMILYWORKS_READY';
    } else if (fwResult.ready === false) {
      familyworks = 'FAMILYWORKS_SESSION_MISSING';
    } else {
      familyworks = 'AUTH_UNKNOWN';
    }

    saveFwStatus({
      ready:     fwResult.ready,
      status:    familyworks,
      checkedAt,
      source,
      detail:    fwResult.detail,
    });

    const detail = `Daxko: OK | FamilyWorks: ${familyworks} — ${fwResult.detail}`;
    console.log('[settings-auth] Result:', detail);
    console.log('[settings-auth] ─────────────────────────────────────');

    return { daxko: 'DAXKO_READY', familyworks, lastVerified: checkedAt, detail, screenshot: null };

  } catch (err) {
    console.warn('[settings-auth] Login flow failed:', err.message);
    const screenshot = err.screenshotPath ? path.basename(err.screenshotPath) : null;

    saveDaxkoStatus({
      valid:     false,
      checkedAt,
      source,
      detail:    err.message || 'Login failed',
      screenshot,
    });

    saveFwStatus({
      ready:     false,
      status:    'FAMILYWORKS_SESSION_MISSING',
      checkedAt,
      source,
      detail:    'Daxko login failed — FamilyWorks session not established',
    });

    console.log('[settings-auth] ─────────────────────────────────────');
    return {
      daxko:       'AUTH_NEEDS_LOGIN',
      familyworks: 'FAMILYWORKS_SESSION_MISSING',
      lastVerified: checkedAt,
      detail:      err.message || 'Login failed',
      screenshot,
    };

  } finally {
    if (sess) {
      try { await sess.close(); } catch (_) {}
    }
  }
}

module.exports = { runSettingsLogin, loadFwStatus };
