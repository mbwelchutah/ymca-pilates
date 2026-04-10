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
const { createSession }  = require('./daxko-session');
const { saveCookies, pingSessionHttp } = require('./session-ping');
const { updateAuthState } = require('./auth-state');

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

  // Try to click a card that is properly sized as a class card.
  // Min 80×30 to avoid tiny time-label fragments.
  // Max 350 height / 1260 width to avoid clicking giant container divs.
  // Real class cards are ~1200×168 based on observed booking logs.
  // We click the first button/link CHILD of the card (same as the booking bot),
  // not the card container itself, so the modal navigation is triggered properly.
  let clicked = false;
  for (let i = 0; i < Math.min(cardCount, 60); i++) {
    const el = cardLocator.nth(i);
    try {
      const box = await el.boundingBox();
      if (!box) continue;
      if (box.width < 80  || box.height < 30)  continue; // too small
      if (box.height > 350 || box.width > 1260) continue; // container div
      // Prefer clicking a child button/link to ensure the modal opens
      const child = el.locator('button, [role="button"], a').first();
      const childCount = await child.count();
      if (childCount > 0) {
        await child.click({ timeout: 3000 });
      } else {
        await el.click({ timeout: 3000 });
      }
      clicked = true;
      console.log(`[settings-session] Clicked card element ${i} (${Math.round(box.width)}×${Math.round(box.height)})`);
      break;
    } catch { /* try next */ }
  }

  if (!clicked) {
    console.log('[settings-session] Could not click any class card.');
    return { ready: null, ssoClickDone: false, detail: 'Could not click any class card' };
  }

  // Wait for the modal's URL signature (register_pu=open) or fall back to time-based wait.
  await page.waitForURL(url => url.toString().includes('register_pu=open') || url.toString().includes('event_instance'), { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Capture all visible button texts for diagnostics regardless of outcome.
  const allBtnTexts = await page.locator('button:visible, [role="button"]:visible, a:visible').allTextContents().catch(() => []);
  const btnSummary  = allBtnTexts.map(t => t.trim()).filter(Boolean).join(' | ') || '(none)';
  console.log(`[settings-session] Visible buttons: ${btnSummary}`);

  // Session-active buttons: Register / Waitlist / and any status button that
  // would NOT appear unless the user is logged in (Completed, Class Canceled,
  // Registration Unavailable, Closed - Full, etc.)
  const sessionReadyBtn = page.locator('button, [role="button"], a').filter({
    hasText: /register\s*now|waitlist|join\s*waitlist|add\s*to\s*waitlist|reserve|register|closed\s*-?\s*full|class\s*canceled|completed|registration\s*unavailable|until\s*open\s*registration/i,
  });

  // Login-required buttons: any variant of "Login/Log in/Sign in to Register".
  // Covers: "Login to Register", "Log in to Register", "Sign in to Register", etc.
  const loginRequiredBtn = page.locator('button, [role="button"], a').filter({
    hasText: /log\s*in\s+to\s+register|sign\s*in\s+to\s+register|login\s+to\s+register/i,
  });

  const hasSessionReady = await sessionReadyBtn.count() > 0;
  const hasLoginRequired = await loginRequiredBtn.count() > 0;

  // If the modal URL is open (register_pu=open) and there is NO login-required button,
  // the session is active even if the class status is "Canceled" / "Completed" / etc.
  const currentUrl = page.url();
  const modalIsOpen = currentUrl.includes('register_pu=open') || currentUrl.includes('event_instance');

  if (hasSessionReady && !hasLoginRequired) {
    const foundText = (await sessionReadyBtn.first().textContent() ?? '').trim();
    console.log(`[settings-session] Modal shows "${foundText}" — FamilyWorks session active.`);
    return { ready: true, ssoClickDone: false, detail: `FamilyWorks session active — "${foundText}" button visible` };
  }

  if (modalIsOpen && !hasLoginRequired) {
    console.log(`[settings-session] Modal opened (URL: ${currentUrl.slice(-60)}) with no login prompt — session active.`);
    return { ready: true, ssoClickDone: false, detail: `FamilyWorks session active — modal open, no login required` };
  }

  if (hasLoginRequired) {
    const foundText = (await loginRequiredBtn.first().textContent() ?? '').trim();
    console.log(`[settings-session] Modal shows "${foundText}" — clicking to trigger SSO...`);
    await loginRequiredBtn.first().click();

    // Wait for navigation (either find_account OAuth or MyAccountV2 if already authed)
    await page.waitForURL(url => url.toString().includes('daxko.com') || url.toString().includes('familyworks'), { timeout: 8000 }).catch(() => {});
    const afterUrl = page.url();
    console.log('[settings-session] After SSO-trigger click, URL:', afterUrl);
    await snap('settings-after-login-to-register');

    const onDaxkoLogin   = afterUrl.includes('daxko.com') && (afterUrl.includes('find_account') || afterUrl.includes('/login'));
    const onDaxkoAccount = afterUrl.includes('daxko.com') && afterUrl.includes('MyAccount');

    if (onDaxkoLogin) {
      // No existing Daxko session — complete the full OAuth login
      console.log('[settings-session] On Daxko login page — completing OAuth credentials...');
      try {
        await page.waitForSelector('input[type="text"], input[type="email"], input[type="tel"]', { timeout: 8000 });
        await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
        await page.click('#submit_button');
        await page.waitForTimeout(1500);
        if ((await page.locator('input[type="password"]').count()) > 0) {
          await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
          await page.click('#submit_button');
        }
        // Wait for Daxko to redirect back to FamilyWorks
        await page.waitForURL(url => url.toString().includes('familyworks'), { timeout: 20000 }).catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(2000);
        console.log('[settings-session] After OAuth login, URL:', page.url());
        await snap('settings-after-oauth');
        // Session should now be established — re-navigate to schedule to confirm
        return { ready: true, ssoClickDone: true, detail: 'Completed Daxko OAuth login — FamilyWorks session established' };
      } catch (loginErr) {
        console.log('[settings-session] OAuth login failed:', loginErr.message.split('\n')[0]);
        return { ready: null, ssoClickDone: true, detail: `OAuth login attempt failed: ${loginErr.message.split('\n')[0]}` };
      }
    }

    if (onDaxkoAccount) {
      // Already authenticated with Daxko — wait for OAuth redirect back to FW
      console.log('[settings-session] On Daxko account page (already auth) — waiting for redirect...');
      await page.waitForURL(url => url.toString().includes('familyworks'), { timeout: 8000 }).catch(() => {
        console.log('[settings-session] No auto-redirect from Daxko account page.');
      });
    }

    return { ready: false, ssoClickDone: true, afterUrl, detail: `Clicked "${foundText}" — SSO triggered` };
  }

  await snap(`settings-modal-unknown-attempt${attempt}`);
  console.log(`[settings-session] Modal opened but no recognized button found. Buttons seen: ${btnSummary}`);
  return { ready: null, ssoClickDone: false, detail: `Modal opened but no recognized button found. Buttons: ${btnSummary}` };
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
    // ── Fast path: Tier-2 HTTP ping ───────────────────────────────────────
    // If saved cookies are still valid (both Daxko + FamilyWorks), skip the
    // browser launch entirely and return success immediately (~1–3 s vs ~30 s).
    try {
      const pingResult = await pingSessionHttp();
      if (pingResult.trusted) {
        console.log('[settings-auth] Tier-2 ping trusted — sessions active, skipping browser login.');
        const fwDetail = `FamilyWorks session active (confirmed via Tier-2 HTTP ping)`;
        saveDaxkoStatus({ valid: true, checkedAt, source, detail: 'Session active (Tier-2 ping)', screenshot: null });
        saveFwStatus({ ready: true, status: 'FAMILYWORKS_READY', checkedAt, source, detail: fwDetail });
        updateAuthState({
          daxkoValid: true, familyworksValid: true,
          bookingAccessConfirmed: true, bookingAccessConfirmedAt: Date.now(),
          lastCheckedAt: Date.now(),
        });
        const detail = `Daxko: OK | FamilyWorks: FAMILYWORKS_READY — ${fwDetail}`;
        console.log('[settings-auth] Result (fast path):', detail);
        console.log('[settings-auth] ─────────────────────────────────────');
        return { daxko: 'DAXKO_READY', familyworks: 'FAMILYWORKS_READY', lastVerified: checkedAt, detail, screenshot: null };
      }
      console.log('[settings-auth] Tier-2 ping miss:', pingResult.detail, '— launching browser for full login.');
    } catch (pingErr) {
      console.log('[settings-auth] Tier-2 ping error:', pingErr.message, '— falling through to browser login.');
    }

    // ── Step 1: Daxko login ───────────────────────────────────────────────
    sess = await createSession({ headless: true });
    console.log('[settings-auth] Daxko login: OK');

    // Save browser cookies for Tier-2 HTTP ping on the next keepalive.
    try {
      const allCookies = await sess.page.context().cookies();
      saveCookies(allCookies);
    } catch (e) {
      console.warn('[settings-auth] Failed to save cookies for Tier-2 ping:', e.message);
    }

    saveDaxkoStatus({
      valid: true,
      checkedAt,
      source,
      detail: 'Login successful via Settings',
      screenshot: null,
    });

    // ── Step 2 / 3: Verify FamilyWorks session ───────────────────────────
    // If createSession() already confirmed the session via the home page or
    // a Tier-2 HTTP ping, skip the schedule embed card-click check entirely.
    let fwResult;
    if (sess._fastValidated || sess._homeValidated) {
      const how = sess._fastValidated ? 'Tier-2 HTTP ping' : 'member home page';
      console.log(`[settings-session] Session already confirmed via ${how} — skipping schedule embed check.`);
      fwResult = { ready: true, ssoClickDone: false, detail: `FamilyWorks session active (confirmed via ${how})` };
    } else {
      // Session state unknown — navigate to schedule embed and probe a class card modal.
      console.log('[settings-session] Navigating to FamilyWorks schedule embed...');
      await sess.page.goto(SCHEDULE_URL, { timeout: 30000 });
      await sess.page.waitForLoadState('networkidle').catch(() => {});
      await sess.page.waitForTimeout(3000);

      fwResult = await checkFwModalSession(sess.page, sess.snap, { attempt: 1 });

      // SSO retry — if "Login to Register" was clicked, navigate back and re-verify once.
      if (!fwResult.ready && fwResult.ssoClickDone) {
        console.log('[settings-session] SSO click done — navigating back to verify session...');
        await sess.page.goto(SCHEDULE_URL, { timeout: 30000 });
        await sess.page.waitForLoadState('networkidle').catch(() => {});
        await sess.page.waitForTimeout(3000);
        fwResult = await checkFwModalSession(sess.page, sess.snap, { attempt: 2 });
      }
    }

    // ── Step 4: Map result to FamilyWorks status ──────────────────────────
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

    // Stage 2: Update canonical AuthState so the UI reflects the new session
    // immediately — without waiting for the next keepalive or session check.
    const fwReady = fwResult.ready === true;
    updateAuthState({
      daxkoValid:               true,
      familyworksValid:         fwReady,
      bookingAccessConfirmed:   fwReady,   // modal confirmed Register/Waitlist → booking surface live
      bookingAccessConfirmedAt: fwReady ? Date.now() : null,
      lastCheckedAt:            Date.now(),
      lastRecoveredAt:          Date.now(),
    });

    // Stage 3: Clear the SNIPER_BLOCKED_AUTH lock so the preflight loop can
    // resume immediately — without this the 20-minute block window persists
    // even after a successful re-login via Settings.
    if (fwReady) {
      try {
        const { loadState, saveState } = require('./sniper-readiness');
        const st = loadState();
        if (st && st.sniperState === 'SNIPER_BLOCKED_AUTH') {
          st.bundle        = { ...st.bundle, session: 'SESSION_READY' };
          st.sniperState   = 'SNIPER_WAITING';
          st.authBlockedAt = null;
          st.updatedAt     = new Date().toISOString();
          saveState(st);
          console.log('[settings-auth] Cleared SNIPER_BLOCKED_AUTH — preflight loop unblocked.');
        }
      } catch (e) {
        console.warn('[settings-auth] Failed to clear auth-block from sniper state:', e.message);
      }
    }

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

    // Stage 2: Update canonical AuthState on failure so the UI resolves immediately.
    updateAuthState({
      daxkoValid:               false,
      familyworksValid:         false,
      bookingAccessConfirmed:   false,
      bookingAccessConfirmedAt: null,
      lastCheckedAt:            Date.now(),
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
