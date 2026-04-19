// Shared Daxko session module — browser launch, login, and auth check.
// Extracted from register-pilates.js so it can be reused by scrape-schedule.js
// and any future bots without duplicating the login sequence.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { updateAuthState } = require('./auth-state');
const { pingSessionHttp, loadCookies } = require('./session-ping');

let CHROMIUM_PATH;
try {
  CHROMIUM_PATH = execSync('which chromium', { encoding: 'utf8' }).trim();
} catch {
  CHROMIUM_PATH = null;
}

// Task #71 — page.goto timeout for Daxko/FamilyWorks auth navigations.
// Bumped from Playwright's 30 s default to 60 s to absorb common slow-network
// blips (YMCA infra, Replit egress) that were causing recurring "Daxko login
// failed (Timeout 30000 ms exceeded — page.goto)" failures during the auth
// phase.  Configurable via DAXKO_GOTO_TIMEOUT_MS for ops.
const DAXKO_GOTO_TIMEOUT_MS =
  Number(process.env.DAXKO_GOTO_TIMEOUT_MS) > 0
    ? Number(process.env.DAXKO_GOTO_TIMEOUT_MS)
    : 60000;

function _isTimeoutError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  return /timeout|timed out/i.test(err.message || '');
}

/**
 * Run page.goto() with the bumped Daxko timeout and a single TimeoutError
 * retry.  The retry is suppressed when `allowRetry` is false — used by the
 * caller to opt out once the booking window has already opened (no time to
 * spare on a second 60 s budget).
 *
 * Exported so the unit test can drive it with a mocked page.
 */
async function gotoWithRetry(page, url, opts = {}) {
  // allowRetry can be a boolean OR a no-arg callback (re-evaluated at the
  // catch site).  The callback form lets the caller re-check "past booking
  // open" right before the retry decision — important because the first
  // attempt can burn a full 60 s and the booking window may have opened
  // during it.
  const allowRetryOpt = opts.allowRetry;
  const gotoOpts      = { timeout: DAXKO_GOTO_TIMEOUT_MS };
  if (opts.waitUntil) gotoOpts.waitUntil = opts.waitUntil;

  try {
    return await page.goto(url, gotoOpts);
  } catch (err) {
    if (!_isTimeoutError(err)) throw err;
    const canRetry =
      typeof allowRetryOpt === 'function'
        ? !!allowRetryOpt()
        : allowRetryOpt !== false;
    if (!canRetry) throw err;
    console.warn(
      `[session] page.goto timeout on first attempt (${url}, ${DAXKO_GOTO_TIMEOUT_MS / 1000}s) — reloading and retrying once.`,
    );
    // Best-effort reload to flush any partial state from the timed-out
    // attempt before the second try.  Failures here are non-fatal — the
    // retry goto below is the actual recovery path.
    try { await page.reload({ timeout: 5000 }).catch(() => {}); } catch (_) {}
    return await page.goto(url, gotoOpts);
  }
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
  const headless         = opts.headless !== false;
  const validateOnly     = opts.validateOnly  === true;
  const skipFastPath     = opts.skipFastPath  === true;
  const screenshotDir    = opts.screenshotDir || 'screenshots';
  // Task #71 — when the booking window has already opened we suppress the
  // one-shot timeout retry: a second 60 s budget would cost the click race.
  // Caller may pass a callback (re-evaluated at the catch site, after the
  // first 60 s attempt has elapsed) or a static boolean.
  const pastBookingOpenOpt = opts.pastBookingOpen;
  const allowGotoRetry =
    typeof pastBookingOpenOpt === 'function'
      ? () => !pastBookingOpenOpt()
      : () => pastBookingOpenOpt !== true;

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

  // ── Container Chromium launch hardening ──────────────────────────────────
  // The Replit container has no X server, no /dev/shm size guarantee, and no
  // working GPU/EGL stack. Without these flags Playwright fails with:
  //   xcb_connect failed / ANGLE Display init failed / eglInitialize failed
  //   / GPU process exited during initialization → 180 s launch timeout.
  // Flags below force a headless software-rasterizer path with no display
  // server and no shared-memory dependency. Booking logic, selectors, and
  // scheduler behavior are NOT touched — this only changes how Chromium boots.
  const _launchArgs = [
    '--no-sandbox',                  // sandbox needs setuid; not available
    '--disable-setuid-sandbox',      // belt-and-suspenders for the above
    '--disable-gpu',                 // no GPU in the container
    '--disable-software-rasterizer', // disable fallback that still probes EGL
    '--disable-dev-shm-usage',       // /dev/shm too small → use /tmp instead
    '--use-gl=swiftshader',          // CPU GL when GL is touched at all
    '--ozone-platform=headless',     // no X/Wayland display server present
  ];
  const browser = await chromium.launch({
    headless,
    args: _launchArgs,
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
  });

  // Set timezone to Pacific (America/Los_Angeles) so Bubble.io's JavaScript
  // renders class times matching the YMCA's local timezone (Eugene, Oregon is
  // Pacific).  The Replit server runs UTC; without this override Chromium
  // inherits UTC and all rendered times are ~7 hours off.
  const context = await browser.newContext({
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1280, height: 800 },
  });

  // ── Stage 1: Inject saved cookies for session reuse ───────────────────────
  // Load cookies saved from the last successful Playwright login and inject
  // them into the new browser context.  If the cookies are still valid the
  // FW schedule modal will show "Register/Waitlist" directly — credentials
  // are never needed.  If expired, the modal shows "Login to Register" and
  // the OAuth flow runs as the recovery path.
  let cookiesInjected = 0;
  try {
    const savedCookies = loadCookies();
    if (savedCookies && savedCookies.length > 0) {
      await context.addCookies(savedCookies);
      cookiesInjected = savedCookies.length;
      console.log(`[session-reuse] Injected ${cookiesInjected} saved cookies — attempting session reuse.`);
    } else {
      console.log('[session-reuse] No saved cookies found — fresh login will be required.');
    }
  } catch (e) {
    console.warn('[session-reuse] Cookie injection failed:', e.message, '— continuing without injected cookies.');
  }

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

  const HOME_URL     = 'https://my.familyworks.app';
  const SCHEDULE_URL = 'https://my.familyworks.app/schedulesembed/eugeneymca?search=yes';

  // ── Step 1: Check FamilyWorks member home page (skipped when ping-trusted) ──
  // When the Tier-2 HTTP ping already confirmed sessions are valid we skip the
  // expensive home-page goto entirely — it can time out in production due to
  // network latency, and the information it provides (session valid/not) is
  // already known from the ping.  Only when the ping was NOT trusted do we load
  // the home page to detect whether a full OAuth re-login is required.
  let sessionAlreadyValid = false;
  let homeValidated       = false;  // true when home page confirmed active session
  let homeShowsMember     = false;
  let homeShowsLoginBtn   = false;

  if (pingTrusted) {
    console.log('[session] Ping-trusted fast path — skipping home page check, sessions assumed valid.');
    sessionAlreadyValid = true;
    updateAuthState({
      daxkoValid:    true,
      familyworksValid: true,
      lastCheckedAt: Date.now(),
    });
  } else {
    // Navigate to the FW home page.  If the session cookie is valid, FW renders
    // the member dashboard (My Schedule, Browse, etc.).  If not, it shows a
    // "Login to Y Account" button.
    console.log('[session] Checking FamilyWorks member home page for existing session...');
    await gotoWithRetry(page, HOME_URL, { waitUntil: 'domcontentloaded', allowRetry: allowGotoRetry });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000); // allow Bubble.io SPA to render

    const homeUrl = page.url();
    console.log('[session] FamilyWorks home URL:', homeUrl);

    const homeBtnTexts = await page.locator('button:visible, [role="button"]:visible, a:visible').allTextContents().catch(() => []);
    const homeClean    = homeBtnTexts.map(t => t.trim()).filter(Boolean);
    console.log('[session] Home page buttons/links:', JSON.stringify(homeClean.slice(0, 15)));

    homeShowsLoginBtn = homeClean.some(t => /login\s+to\s+y\s+account|sign\s+in/i.test(t));
    const homeBodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    homeShowsMember = !homeShowsLoginBtn && (
      homeBodyText.includes('my schedule') ||
      homeBodyText.includes('browse') ||
      homeBodyText.includes('eugene y') ||
      homeBodyText.includes('health & wellness') ||
      homeClean.some(t => /my favorites|new app feedback|donate/i.test(t))
    );

    console.log(`[session] Home check: loginBtn=${homeShowsLoginBtn} memberDash=${homeShowsMember}`);
  }

  if (!pingTrusted && homeShowsMember) {
    // Member dashboard visible → session is active, no login needed.
    const reuseMsg = cookiesInjected > 0
      ? `[session-reuse] ✓ Session reused — member dashboard visible (${cookiesInjected} cookies active).`
      : '[session] FW session already valid — member dashboard visible.';
    console.log(reuseMsg);
    sessionAlreadyValid = true;
    homeValidated = true;
    updateAuthState({
      daxkoValid:               true,
      familyworksValid:         true,
      bookingAccessConfirmed:   true,
      bookingAccessConfirmedAt: Date.now(),
      lastCheckedAt:            Date.now(),
    });
  } else if (!pingTrusted) {
    // "Login to Y Account" visible (or unrecognised state) — need Daxko OAuth.
    // The OAuth flow MUST go through the schedule embed: navigate there, click a
    // class card, and click "Login to Register" so FW triggers the Daxko OAuth
    // redirect with the correct oauth_state parameter.  Pre-navigating to Daxko
    // first breaks the flow (Daxko skips the OAuth redirect to MyAccountV2.mvc).
    const credMsg = homeShowsLoginBtn
      ? (cookiesInjected > 0
          ? '[session-reuse] ✗ Saved cookies expired — "Login to Y Account" visible. Using credentials.'
          : '[session] Not logged in — "Login to Y Account" visible. Initiating FW OAuth via Daxko...')
      : '[session] Login state unclear from home page — falling back to schedule embed probe.';
    console.log(credMsg);

    // Load the schedule embed to get a class card for the OAuth trigger.
    console.log('[session] Loading schedule embed for OAuth flow...');
    await gotoWithRetry(page, SCHEDULE_URL, { allowRetry: allowGotoRetry });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(4000); // Bubble.io needs time to render class cards

    console.log('[session] Schedule embed loaded. URL:', page.url());

    const cardLocator = page.locator('*').filter({ hasText: /\d:\d+ [ap] - \d+:\d+ [ap]/i });
    const cardCount   = await cardLocator.count();
    console.log(`[session] Class cards visible: ${cardCount}`);

    if (cardCount > 0) {
      let clicked = false;
      for (let i = 0; i < Math.min(cardCount, 10); i++) {
        const el = cardLocator.nth(i);
        try {
          const box = await el.boundingBox();
          if (!box || box.width < 80 || box.height < 30) continue;
          if (box.height > 350 || box.width > 1260) continue;
          await el.click({ timeout: 3000 });
          clicked = true;
          console.log(`[session] Clicked class card ${i} (${Math.round(box.width)}x${Math.round(box.height)})`);
          break;
        } catch (_) {}
      }

      if (clicked) {
        await page.waitForTimeout(2500);

        const allBtnTexts = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(() => []);
        const cleanBtns   = allBtnTexts.map(t => t.trim()).filter(Boolean);
        console.log('[session] Modal buttons:', JSON.stringify(cleanBtns));

        const hasLoginRequired = cleanBtns.some(t => /log\s*in\s+to\s+register|sign\s*in\s+to\s+register|login\s+to\s+register/i.test(t));

        if (!hasLoginRequired) {
          // Modal shows Register/Waitlist — session became valid somehow.
          console.log('[session] Modal shows action buttons — session valid (unexpected but OK).');
          sessionAlreadyValid = true;
          updateAuthState({
            daxkoValid: true, familyworksValid: true,
            bookingAccessConfirmed: true, bookingAccessConfirmedAt: Date.now(), lastCheckedAt: Date.now(),
          });
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(500);
        } else {
          // Click "Login to Register" → triggers Daxko OAuth redirect
          const loginBtn = page.locator(
            'button:has-text("Login to Register"), [role="button"]:has-text("Login to Register"), a:has-text("Login to Register")'
          ).first();

          if ((await loginBtn.count()) > 0) {
            await loginBtn.click();
            await page.waitForURL(url => url.toString().includes('daxko.com'), { timeout: 10000 }).catch(() => {});
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(1000);

            const afterClickUrl = page.url();
            console.log('[session] After "Login to Register" click, URL:', afterClickUrl);

            const isLoginPage = afterClickUrl.includes('daxko.com') &&
                                (afterClickUrl.includes('find_account') || afterClickUrl.includes('/login'));
            const isAccountPg = afterClickUrl.includes('daxko.com') && afterClickUrl.includes('MyAccount');

            if (isLoginPage) {
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

              if (!page.url().includes('familyworks')) {
                await page.waitForURL(url => url.toString().includes('familyworks'), { timeout: 15000 }).catch(() => {});
              }
              await page.waitForLoadState('networkidle').catch(() => {});
              await page.waitForTimeout(2000);
              console.log('[session] After Daxko login + FW redirect, URL:', page.url());
              updateAuthState({
                daxkoValid: true, familyworksValid: true,
                bookingAccessConfirmed: false, bookingAccessConfirmedAt: null,
                lastRecoveredAt: Date.now(), lastCheckedAt: Date.now(),
              });

            } else if (isAccountPg) {
              console.log('[session] On Daxko account page — waiting for OAuth redirect to FW...');
              await page.waitForURL(url => url.toString().includes('familyworks'), { timeout: 10000 }).catch(() => {
                console.log('[session] No OAuth redirect received.');
              });
              console.log('[session] URL after account-page wait:', page.url());

            } else {
              console.log('[session] Unexpected URL after "Login to Register" click — may need manual check.');
            }
          } else {
            console.log('[session] "Login to Register" button not found in modal.');
          }
        }
      } else {
        console.log('[session] Could not click any class card — schedule may still be loading.');
      }
    } else {
      console.log('[session] No class cards found on schedule embed — skipping OAuth probe.');
    }
  }

  // ---- Auth check: confirm session is established ----
  const postLoginUrl = page.url();
  const passwordFieldGone = await page.locator('input[type="password"]').count() === 0;
  const stillOnLogin = postLoginUrl.includes('/login') && postLoginUrl.includes('daxko.com') &&
                       (postLoginUrl.includes('find_account') || !postLoginUrl.includes('MyAccount'));
  console.log('Post-auth URL:', postLoginUrl, '| Password field gone:', passwordFieldGone, '| Still on login:', stillOnLogin);

  if (!sessionAlreadyValid && stillOnLogin) {
    const screenshotPath = await snap('login-failed');
    updateAuthState({ daxkoValid: false, familyworksValid: false, bookingAccessConfirmed: false, bookingAccessConfirmedAt: null, lastCheckedAt: Date.now() });
    await close();
    const loginErr = new Error('Login failed or session not established');
    loginErr.screenshotPath = screenshotPath;
    throw loginErr;
  }
  console.log('Auth looks valid — proceeding.');

  // ---- Step 2: Navigate to FW schedule embed (ready for booking) ----
  // The caller (register-pilates.js) always expects to start from the schedule
  // embed, not the home page or Daxko. Navigate there unless already on it.
  if (!page.url().includes('schedulesembed')) {
    console.log('[session] Navigating to FW schedule embed...');
    await gotoWithRetry(page, SCHEDULE_URL, { allowRetry: allowGotoRetry });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
  }
  console.log('[session] Ready. Final URL:', page.url());

  return { browser, page, snap, close, _homeValidated: homeValidated };
}

module.exports = { createSession, CHROMIUM_PATH, gotoWithRetry, DAXKO_GOTO_TIMEOUT_MS };
