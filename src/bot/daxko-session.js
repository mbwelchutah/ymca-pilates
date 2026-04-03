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
  await page.goto('https://operations.daxko.com/online/3100/Security/login.mvc/find_account');
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
    await snap('login-failed');
    await close();
    throw new Error('Login failed or session not established');
  }
  console.log('Auth looks valid — proceeding.');

  return { browser, page, snap, close };
}

module.exports = { createSession, CHROMIUM_PATH };
