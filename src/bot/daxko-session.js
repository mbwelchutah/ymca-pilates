// Shared Daxko session module — browser launch, login, and auth check.
// Extracted from register-pilates.js so it can be reused by scrape-schedule.js
// and any future bots without duplicating the login sequence.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { updateAuthState } = require('./auth-state');
const { pingSessionHttp } = require('./session-ping');

let CHROMIUM_PATH;
try {
  CHROMIUM_PATH = execSync('which chromium', { encoding: 'utf8' }).trim();
} catch {
  CHROMIUM_PATH = null;
}

/**
 * Launch Chromium, log in to Daxko, and return a ready-to-use session.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.headless=true]        Run headless (false = visible browser)
 * @param {string}  [opts.screenshotDir='screenshots']  Where to save screenshots
 * @param {boolean} [opts.validateOnly=false]   If true and Tier-2 ping succeeds,
 *                                              skip the browser entirely and return
 *                                              a lightweight stub session. Use this
 *                                              for credential checks (session-check)
 *                                              where no DOM interaction is needed.
 * @param {boolean} [opts.skipFastPath=false]   Force a full browser launch even when
 *                                              a Tier-2 ping would normally short-circuit.
 *
 * @returns {Promise<{
 *   browser: import('playwright').Browser | null,
 *   page: import('playwright').Page | object,
 *   snap: (label?: string) => Promise<string|null>,
 *   close: () => Promise<void>,
 *   _fastValidated?: boolean,
 * }>}
 *
 * Throws if login fails. The caller is responsible for calling close() after use
 * (use try/finally).
 */
async function createSession(opts = {}) {
  const headless      = opts.headless !== false;
  const validateOnly  = opts.validateOnly  === true;
  const skipFastPath  = opts.skipFastPath  === true;
  const screenshotDir = opts.screenshotDir || 'screenshots';

  // ── Stage 3: Fast validation — try HTTP ping before touching a browser ────
  // If saved cookies are still valid (Tier-2 HTTP ping), we can skip the entire
  // Playwright launch + FW OAuth dance.  Only bypassed when skipFastPath is true.
  let pingTrusted = false;
  if (!skipFastPath) {
    try {
      const pingResult = await pingSessionHttp();
      pingTrusted = pingResult.trusted === true;
      if (pingTrusted) {
        console.log('[session] Tier-2 pre-flight ping trusted — sessions valid.');
      } else {
        console.log('[session] Tier-2 pre-flight ping miss:', pingResult.detail);
      }
    } catch (e) {
      console.log('[session] Tier-2 pre-flight ping error:', e.message, '— falling through to browser.');
    }
  }

  // validateOnly + trusted → return a stub session, no browser needed.
  if (pingTrusted && validateOnly) {
    console.log('[session] validateOnly + ping trusted — skipping browser launch.');
    return {
      browser: null,
      page: { context: () => ({ cookies: async () => [] }) },
      snap:  async () => null,
      close: async () => {},
      _fastValidated: true,
    };
  }

  const browser = await chromium.launch({
    headless,
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
  });

  // Set timezone to Pacific so Bubble.io's JavaScript renders class times in
  // PDT/PST — the Replit server runs UTC, which shifts all times +7 hours.
  const context = await browser.newContext({
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // snap — saves a full-page screenshot and trims the directory to 20 files.
  const snap = async (label = '') => {
    try {
      fs.mkdirSync(screenshotDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const suffix = label ? `-${label}` : '';
      const p = path.join(screenshotDir, `${ts}${suffix}.png`);
      await page.screenshot({ path: p, fullPage: true });
      console.log('Screenshot saved:', p);
      const files = fs.readdirSync(screenshotDir)
        .map(name => ({ name, mtime: fs.statSync(path.join(screenshotDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      files.slice(20).forEach(f => {
        try { fs.unlinkSync(path.join(screenshotDir, f.name)); } catch (_) {}
      });
      return p;
    } catch (e) {
      console.log('Screenshot failed:', e.message);
      return null;
    }
  };

  const close = async () => {
    try { await browser.close(); } catch (_) {}
  };

  // ---- Step 1: Establish FamilyWorks + Daxko sessions via FW-first OAuth ----
  //
  // The correct auth flow (confirmed by user):
  //   1. Navigate to the FW schedule embed (publicly accessible without login)
  //   2. Open a class card → modal shows "Login to Register" (no FW session)
  //   3. Click "Login to Register" → FW redirects to Daxko's find_account page
  //      (this works because we have NO Daxko session yet — if we pre-login to
  //      Daxko first, we land on MyAccountV2.mvc instead and the OAuth callback
  //      never completes)
  //   4. Fill credentials at Daxko → submit
  //   5. Daxko redirects back to FamilyWorks → FW session cookie set ✓
  //      (Daxko session is also established in this same browser context)
  //
  // Doing Daxko login FIRST (old approach) breaks step 3 — already-authenticated
  // Daxko sends the user to MyAccountV2.mvc instead of completing the OAuth
  // redirect back to FamilyWorks.

  const SCHEDULE_URL = 'https://my.familyworks.app/schedulesembed/eugeneymca?search=yes';

  console.log('[session] Starting FW-first OAuth auth flow...');
  await page.goto(SCHEDULE_URL, { timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000); // Bubble.io needs time to render class cards

  console.log('[session] Schedule embed loaded. URL:', page.url());

  // Look for class cards (any element with a time range)
  const cardLocator = page.locator('*').filter({ hasText: /\d:\d+ [ap] - \d+:\d+ [ap]/i });
  const cardCount = await cardLocator.count();
  console.log(`[session] Class cards visible: ${cardCount}`);

  // ── Fast path: Tier-2 ping already confirmed sessions valid ──────────────
  // Skip the entire FW OAuth modal probe — sessions are trusted, no login needed.
  let sessionAlreadyValid = false;

  if (pingTrusted) {
    console.log('[session] Ping-trusted fast path — skipping OAuth probe, sessions assumed valid.');
    sessionAlreadyValid = true;
    updateAuthState({
      daxkoValid:          true,
      familyworksValid:    true,
      bookingSurfaceValid: false, // confirmed later by booking code probing the modal
      lastCheckedAt:       Date.now(),
    });
  } else if (cardCount > 0) {
    // Click the first visible, reasonably-sized card
    let clicked = false;
    for (let i = 0; i < Math.min(cardCount, 10); i++) {
      const el = cardLocator.nth(i);
      try {
        const box = await el.boundingBox();
        if (!box || box.width < 80 || box.height < 30) continue;
        if (box.height > 350 || box.width > 1260) continue; // skip container divs
        await el.click({ timeout: 3000 });
        clicked = true;
        console.log(`[session] Clicked class card ${i} (${Math.round(box.width)}x${Math.round(box.height)})`);
        break;
      } catch (_) {}
    }

    if (clicked) {
      await page.waitForTimeout(2500);

      // Check what button appears in the modal
      const allBtnTexts = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(() => []);
      const cleanBtns   = allBtnTexts.map(t => t.trim()).filter(Boolean);
      console.log('[session] Modal buttons:', JSON.stringify(cleanBtns));

      const hasSessionReady = cleanBtns.some(t => /^(Register|Reserve|Waitlist|Join Waitlist|Add to Waitlist)$/i.test(t));
      const hasLoginRequired = cleanBtns.some(t => /log\s*in\s+to\s+register|sign\s*in\s+to\s+register|login\s+to\s+register/i.test(t));

      if (hasSessionReady) {
        console.log('[session] FW session already valid — Register/Waitlist button visible.');
        sessionAlreadyValid = true;
        updateAuthState({
          daxkoValid:          true,
          familyworksValid:    true,
          bookingSurfaceValid: true,
          lastCheckedAt:       Date.now(),
        });
        // Close the modal before continuing
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      } else if (hasLoginRequired) {
        console.log('[session] Modal shows "Login to Register" — initiating FW OAuth via Daxko...');

        // Click "Login to Register" — because we have NO Daxko session yet,
        // this should redirect to Daxko's find_account login page.
        const loginBtn = page.locator(
          'button:has-text("Login to Register"), [role="button"]:has-text("Login to Register"), a:has-text("Login to Register")'
        ).first();

        if ((await loginBtn.count()) > 0) {
          await loginBtn.click();
          // Wait for navigation to Daxko
          await page.waitForURL(url => url.toString().includes('daxko.com'), { timeout: 10000 }).catch(() => {});
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(1000);

          const afterClickUrl = page.url();
          console.log('[session] After "Login to Register" click, URL:', afterClickUrl);

          const isLoginPage  = afterClickUrl.includes('daxko.com') &&
                               (afterClickUrl.includes('find_account') || afterClickUrl.includes('/login'));
          const isAccountPg  = afterClickUrl.includes('daxko.com') && afterClickUrl.includes('MyAccount');

          if (isLoginPage) {
            // Full Daxko login — fill credentials
            console.log('[session] On Daxko login page — filling credentials...');
            await page.waitForSelector('input[type="text"], input[type="email"], input[type="tel"]', { timeout: 10000 });
            await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
            await page.click('#submit_button');
            await page.waitForTimeout(1500);
            if ((await page.locator('input[type="password"]').count()) > 0) {
              await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
              console.log('Submitting login...');
              await Promise.all([
                page.waitForURL(url => !url.toString().includes('find_account') && !url.toString().includes('/login'), { timeout: 30000 }),
                page.click('#submit_button'),
              ]);
            }
            console.log('Login submit complete. URL:', page.url());

            // Wait for FamilyWorks redirect to complete
            if (!page.url().includes('familyworks')) {
              await page.waitForURL(url => url.toString().includes('familyworks'), { timeout: 15000 }).catch(() => {});
            }
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForTimeout(2000);
            console.log('[session] After Daxko login + FW redirect, URL:', page.url());
            updateAuthState({
              daxkoValid:          true,
              familyworksValid:    true,
              bookingSurfaceValid: false, // not confirmed until modal probe
              lastRecoveredAt:     Date.now(),
              lastCheckedAt:       Date.now(),
            });

          } else if (isAccountPg) {
            // Already authenticated somehow — wait for OAuth redirect to FW
            console.log('[session] On Daxko account page — waiting for OAuth redirect to FW...');
            await page.waitForURL(url => url.toString().includes('familyworks'), { timeout: 10000 }).catch(() => {
              console.log('[session] No OAuth redirect received.');
            });
            console.log('[session] URL after account-page wait:', page.url());

          } else {
            console.log('[session] Unexpected URL after Login to Register click — may need manual check.');
          }
        } else {
          console.log('[session] "Login to Register" button not found in modal.');
        }
      } else {
        console.log('[session] No recognized buttons in modal. Buttons seen:', JSON.stringify(cleanBtns));
      }
    } else {
      console.log('[session] Could not click any class card — schedule may still be loading.');
    }
  } else {
    console.log('[session] No class cards found on schedule embed — skipping auth probe.');
  }

  // ---- Auth check: confirm session is established ----
  const postLoginUrl = page.url();
  const passwordFieldGone = await page.locator('input[type="password"]').count() === 0;
  const stillOnLogin = postLoginUrl.includes('/login') && postLoginUrl.includes('daxko.com') &&
                       (postLoginUrl.includes('find_account') || !postLoginUrl.includes('MyAccount'));
  console.log('Post-auth URL:', postLoginUrl, '| Password field gone:', passwordFieldGone, '| Still on login:', stillOnLogin);

  if (!sessionAlreadyValid && stillOnLogin) {
    const screenshotPath = await snap('login-failed');
    updateAuthState({ daxkoValid: false, familyworksValid: false, bookingSurfaceValid: false });
    await close();
    const loginErr = new Error('Login failed or session not established');
    loginErr.screenshotPath = screenshotPath;
    throw loginErr;
  }
  console.log('Auth looks valid — proceeding.');

  // ---- Step 2: Navigate back to FW schedule embed (ready for booking) ----
  // After FW-first OAuth the page may be on any URL. Bring it back to the
  // schedule embed so the caller (register-pilates.js) always starts from
  // a known, loaded schedule page.
  if (!page.url().includes('familyworks')) {
    console.log('[session] Navigating to FW schedule embed post-auth...');
    await page.goto(SCHEDULE_URL, { timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
  }
  console.log('[session] Ready. Final URL:', page.url());

  return { browser, page, snap, close };
}

module.exports = { createSession, CHROMIUM_PATH };
