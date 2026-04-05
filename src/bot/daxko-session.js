// Shared Daxko session module — browser launch, login, and auth check.
// Extracted from register-pilates.js so it can be reused by scrape-schedule.js
// and any future bots without duplicating the login sequence.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

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
 * @param {boolean} [opts.headless=true]       Run headless (false = visible browser)
 * @param {string}  [opts.screenshotDir='screenshots']  Where to save screenshots
 *
 * @returns {Promise<{
 *   browser: import('playwright').Browser,
 *   page: import('playwright').Page,
 *   snap: (label?: string) => Promise<string|null>,
 *   close: () => Promise<void>,
 * }>}
 *
 * Throws if login fails. The caller is responsible for calling close() after use
 * (use try/finally).
 */
async function createSession(opts = {}) {
  const headless = opts.headless !== false;
  const screenshotDir = opts.screenshotDir || 'screenshots';

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

  // ---- Step 1: Log in via Daxko ----
  await page.goto('https://operations.daxko.com/online/3100/Security/login.mvc/find_account', { timeout: 60000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('input[type="text"]:visible, input[type="email"]:visible');
  await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
  await page.click('#submit_button');
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
  console.log('Submitting login...');
  await Promise.all([
    page.waitForURL(url => {
      const s = url.toString();
      return !s.includes('find_account') && !s.includes('/login');
    }, { timeout: 30000 }),
    page.click('#submit_button'),
  ]);
  console.log('Login submit complete. URL:', page.url());

  // ---- Auth check: confirm we are no longer on a login page ----
  const postLoginUrl = page.url();
  const passwordFieldGone = await page.locator('input[type="password"]').count() === 0;
  const stillOnLogin = postLoginUrl.includes('/login') || postLoginUrl.includes('find_account');
  console.log('Password field gone:', passwordFieldGone, '| Still on login page:', stillOnLogin);
  if (stillOnLogin || !passwordFieldGone) {
    const screenshotPath = await snap('login-failed');
    await close();
    const loginErr = new Error('Login failed or session not established');
    loginErr.screenshotPath = screenshotPath;
    throw loginErr;
  }
  console.log('Auth looks valid — proceeding.');

  // ---- Step 2: Establish Familyworks member session (non-fatal) ----
  // The schedule embed (my.familyworks.app) requires its own session for
  // booking. Familyworks uses Daxko SSO — navigating to their sign-in page
  // while already authenticated with Daxko should complete the SSO handshake
  // and set the Familyworks session cookie automatically.
  try {
    console.log('[session] Attempting Familyworks pre-auth (SSO)...');
    await page.goto('https://my.familyworks.app/eugeneymca', { timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    const fwUrl = page.url();
    console.log('[session] Familyworks landing URL:', fwUrl);

    // Check if Familyworks already recognises us as signed in
    const alreadySignedIn = (await page.locator('text=/my account|log out|sign out|my profile/i').count()) > 0;
    if (alreadySignedIn) {
      console.log('[session] Familyworks: already signed in — session established.');
    } else {
      // Look for a Sign-In / Log-In button or link
      const signInBtn = page.locator(
        'button:has-text("Sign In"), a:has-text("Sign In"), button:has-text("Log In"), a:has-text("Log In"), [href*="login"], [href*="signin"]'
      ).first();
      if ((await signInBtn.count()) > 0) {
        console.log('[session] Familyworks: clicking Sign In...');
        await signInBtn.click();
        await page.waitForTimeout(3000);
        const afterClickUrl = page.url();
        console.log('[session] After Sign In click, URL:', afterClickUrl);

        // If Daxko SSO redirected back and we're done, great.
        // If a login form appeared (not Daxko-native), fill credentials.
        const hasEmailField = (await page.locator('input[type="email"], input[type="text"]').count()) > 0;
        const isOnDaxkoLogin = afterClickUrl.includes('daxko.com') && afterClickUrl.includes('find_account');

        if (isOnDaxkoLogin) {
          // Daxko SSO redirect — we should already be authenticated; submit the
          // email to trigger the SSO short-circuit.
          console.log('[session] SSO redirected to Daxko — submitting email to complete SSO...');
          await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
          await page.click('#submit_button');
          await page.waitForTimeout(1500);
          // If password field appears, fill it too
          if ((await page.locator('input[type="password"]').count()) > 0) {
            await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
            await page.click('#submit_button');
          }
          await page.waitForTimeout(3000);
          console.log('[session] SSO complete. Final URL:', page.url());
        } else if (hasEmailField && !isOnDaxkoLogin) {
          // Familyworks-native login form
          console.log('[session] Familyworks native login form — filling credentials...');
          await page.fill('input[type="email"], input[type="text"]', process.env.YMCA_EMAIL);
          const passField = page.locator('input[type="password"]').first();
          if ((await passField.count()) > 0) {
            await passField.fill(process.env.YMCA_PASSWORD);
          }
          const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
          if ((await submitBtn.count()) > 0) {
            await submitBtn.click();
            await page.waitForTimeout(3000);
          }
          console.log('[session] Familyworks login submitted. URL:', page.url());
        } else {
          console.log('[session] Familyworks: no login form detected after Sign In click.');
        }
      } else {
        console.log('[session] Familyworks: no Sign In button found — page may be public or layout differs.');
      }
    }
  } catch (fwErr) {
    console.log('[session] Familyworks pre-auth step failed (non-fatal):', fwErr.message);
  }

  return { browser, page, snap, close };
}

module.exports = { createSession, CHROMIUM_PATH };
