// Bot entry point — run by GitHub Actions every Sunday at 2:45 PM UTC.
// Logs into Daxko, finds the Wednesday Core Pilates class with Stephanie
// Sanders, and registers (or joins the waitlist). Set DRY_RUN=1 to run
// with a visible browser without clicking Register/Waitlist.
const fs = require('fs');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const DRY_RUN = process.env.DRY_RUN === '1';
const isHeadless = process.env.HEADLESS !== 'false';
if (DRY_RUN) console.log('--- DRY RUN MODE: will not click Register/Waitlist ---');

// Use the system Chromium (installed via Nix) so the required shared libraries
// (libgbm, libglib, etc.) are available. Playwright's bundled chrome-headless-shell
// cannot find them in this environment.
let CHROMIUM_PATH;
try {
  CHROMIUM_PATH = execSync('which chromium', { encoding: 'utf8' }).trim();
} catch {
  CHROMIUM_PATH = null;
}

async function runBookingJob(job) {
  const { classTitle, classTime, maxAttempts: maxAttemptsOpt } = job;
  const classTitleLower = classTitle.toLowerCase();
  // Normalize DB time "7:45 AM" → "7:45 a" to match page text like "7:45 a - 8:45 a"
  const classTimeNorm = classTime
    ? classTime.trim().toLowerCase().replace(/^(\d+:\d+)\s*(am|pm).*/, (_, t, ap) => t + ' ' + ap[0])
    : null;
  let browser;
  let screenshotPath = null;

  try {
    browser = await chromium.launch({
      headless: isHeadless,
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    });
    const page = await browser.newPage();

    const snap = async () => {
      try {
        fs.mkdirSync('screenshots', { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const p = `screenshots/${ts}.png`;
        await page.screenshot({ path: p });
        screenshotPath = p;
      } catch (e) {
        console.log('Screenshot failed:', e.message);
      }
    };

    // Step 1: Log in via Daxko
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

    // Auth check: confirm we are no longer on a login page
    const postLoginUrl = page.url();
    const passwordFieldGone = await page.locator('input[type="password"]').count() === 0;
    const stillOnLogin = postLoginUrl.includes('/login') || postLoginUrl.includes('find_account');
    console.log('Password field gone:', passwordFieldGone, '| Still on login page:', stillOnLogin);
    if (stillOnLogin || !passwordFieldGone) {
      console.log('Login appears to have failed.');
      await snap();
      return { status: 'error', message: 'Login failed or session not established', screenshotPath };
    }
    console.log('Auth looks valid — proceeding.');

    // Step 2: Go to schedule and filter by Stephanie Sanders instructor
    console.log('Navigating to schedule...');
    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4000);
    console.log('Schedule loaded. URL:', page.url());

    // Auth check: if the schedule page is asking us to log in, session didn't carry over
    const loginPrompt = await page.locator('text=/login to register/i').count();
    if (loginPrompt > 0) {
      console.log('Schedule page shows "Login to Register" — session not established.');
      await snap();
      return { status: 'error', message: 'Session not established — schedule page requires login', screenshotPath };
    }
    console.log('Auth valid on schedule page — continuing.');

    // Wait for any dropdown to have options loaded (Bubble.io loads them async)
    await page.waitForFunction(() => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (sel.options.length > 1) return true;
      }
      return false;
    }, { timeout: 15000 }).catch(() => console.log('⚠️ Dropdown options slow to load, proceeding anyway'));

    // Find and select Stephanie Sanders using evaluate (Bubble needs dispatchEvent)
    const selectedInstructor = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.text.toLowerCase().includes('stephanie')) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return opt.text;
          }
        }
      }
      const allOpts = [];
      for (const sel of selects) {
        for (const opt of sel.options) {
          allOpts.push(opt.text);
        }
      }
      return 'NOT_FOUND:' + allOpts.join('|');
    });

    if (selectedInstructor.startsWith('NOT_FOUND:')) {
      console.log('⚠️ Stephanie not found. Available options: ' + selectedInstructor.replace('NOT_FOUND:', ''));
      console.log('Proceeding without instructor filter...');
    } else {
      console.log('✅ Selected instructor: ' + selectedInstructor);
    }
    await page.waitForTimeout(2000);

    console.log(`Looking for: "${classTitle}" at "${classTime || 'any time'}" (normalized: "${classTimeNorm || 'n/a'}")`);

    // Step 3: Find the target class with Stephanie on the next available Wednesday
    async function findTargetCard() {
      const result = await page.evaluate(({ classTitleLower, classTimeNorm }) => {
        document.querySelectorAll('[data-target-class]').forEach(el => {
          el.removeAttribute('data-target-class');
        });

        // Find elements whose own direct text nodes say "Stephanie S." (with dot)
        // The dot distinguishes "Stephanie S." from "Stephanie Sanders" in the filter.
        const stephanieEls = [];
        for (const el of document.querySelectorAll('*')) {
          const directText = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent.trim())
            .filter(t => t.length > 0)
            .join('');
          if (/stephanie\s+s\./i.test(directText)) stephanieEls.push(el);
        }

        const timeRejected = [];

        for (const stephanieEl of stephanieEls) {
          let ancestor = stephanieEl.parentElement;
          while (ancestor && ancestor !== document.body) {
            const txt = ancestor.textContent.toLowerCase();
            // First ancestor with the class title but NOT "level 2" = the class card
            if (txt.includes(classTitleLower) && !txt.includes(classTitleLower + ' level 2')) {
              // Trace back from stephanieEl to its direct-child-of-ancestor level
              let clickTarget = stephanieEl;
              while (clickTarget.parentElement && clickTarget.parentElement !== ancestor) {
                clickTarget = clickTarget.parentElement;
              }
              if (clickTarget.parentElement === ancestor) {
                const rowText = clickTarget.textContent.toLowerCase();
                // Time check: skip this row if it doesn't match the intended time
                if (classTimeNorm && !rowText.includes(classTimeNorm)) {
                  timeRejected.push(clickTarget.textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
                  break; // wrong time — try next stephanieEl
                }
                clickTarget.setAttribute('data-target-class', 'yes');
                return {
                  matched: clickTarget.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
                  timeRejected,
                  debug: null
                };
              }
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }

        return {
          matched: null,
          timeRejected,
          debug: {
            stephanieElCount: stephanieEls.length,
            stephanieTexts: stephanieEls.slice(0, 4).map(el =>
              el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
          }
        };
      }, { classTitleLower, classTimeNorm });

      if (result.timeRejected && result.timeRejected.length > 0) {
        result.timeRejected.forEach(r => console.log('  Rejected (time mismatch):', r));
      }
      if (result.matched) {
        console.log('Matched row:', result.matched);
        return page.locator('[data-target-class="yes"]').first();
      }

      if (result.debug) console.log('findTargetCard debug:', JSON.stringify(result.debug));
      return null;
    }

    // Try each Wednesday tab until we find the class
    const wedTabs = page.locator('text=/Wed \\d+/');
    const wedCount = await wedTabs.count();
    let targetCard = null;

    for (let w = 0; w < wedCount; w++) {
      const tabText = await wedTabs.nth(w).textContent();
      console.log('Trying Wednesday tab: ' + tabText.trim());
      await wedTabs.nth(w).click();
      await page.waitForTimeout(2000);
      targetCard = await findTargetCard();
      if (targetCard) {
        console.log('Found class on ' + tabText.trim());
        break;
      }
      console.log('Class not found on ' + tabText.trim() + ', trying next Wednesday...');
    }

    if (!targetCard) {
      const msg = `Could not find ${classTitle} with Stephanie on any Wednesday.`;
      console.log(msg);
      await snap();
      return { status: 'error', message: msg, screenshotPath };
    }

    await targetCard.click();
    await page.waitForTimeout(2000);

    // Step 5: Try to register — retry every 30s for up to 10 minutes if not open yet.
    // maxAttemptsOpt can be passed in job object (e.g. 1 for web UI, 20 for cron).
    const maxAttempts = maxAttemptsOpt || 20;
    let registered = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const registerBtn = page.locator('button:has-text("Register")');
      const waitlistBtn = page.locator('button:has-text("aitlist")');
      const hasRegister = await registerBtn.count() > 0;
      const hasWaitlist = await waitlistBtn.count() > 0;

      // Log all visible buttons for debugging
      const allBtns = await page.locator('button:visible').allTextContents();
      console.log('Attempt ' + attempt + ': visible buttons: ' + JSON.stringify(allBtns));

      const hasLoginButton = allBtns.some(b => b.toLowerCase().includes('login to register'));
      if (hasLoginButton) {
        console.log('Session not authenticated — page shows "Login to Register". Failing fast.');
        await snap();
        return { status: 'error', message: 'Authentication/session failed: page shows "Login to Register"', screenshotPath };
      }

      if (hasRegister) {
        if (DRY_RUN) {
          console.log('DRY RUN: Would click Register button. Done.');
          registered = true;
          break;
        }
        await registerBtn.first().click();
        console.log('SUCCESS: Registered for Core Pilates 7:45 AM with Stephanie');
        registered = true;
        break;
      } else if (hasWaitlist) {
        if (DRY_RUN) {
          console.log('DRY RUN: Would click Waitlist button. Done.');
          registered = true;
          break;
        }
        await waitlistBtn.first().click();
        console.log('WAITLIST: Class full — joined waitlist for Core Pilates 7:45 AM');
        registered = true;
        break;
      } else {
        console.log('Attempt ' + attempt + ': No register/waitlist button found.' + (DRY_RUN ? ' (dry run — pausing 10s for inspection)' : ' Retrying in 30s...'));
        if (DRY_RUN) { await page.waitForTimeout(10000); break; }
        await page.waitForTimeout(30000);
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);

        // Re-find the correct Wednesday tab after reload
        const wedTabsRetry = page.locator('text=/Wed \\d+/');
        const wedCountRetry = await wedTabsRetry.count();
        for (let w = 0; w < wedCountRetry; w++) {
          await wedTabsRetry.nth(w).click();
          await page.waitForTimeout(2000);
          targetCard = await findTargetCard();
          if (targetCard) break;
        }

        if (targetCard) await targetCard.click().catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    if (!registered) {
      const msg = 'Registration did not open within the retry window.';
      console.log('FAILED: ' + msg);
      await snap();
      return { status: 'error', message: msg, screenshotPath };
    }

    const successMsg = DRY_RUN
      ? `DRY RUN complete for ${classTitle}`
      : `Registered for ${classTitle} with Stephanie`;
    await snap();
    return { status: 'success', message: successMsg, screenshotPath };

  } catch (err) {
    console.error('❌ Error:', err.message);
    return { status: 'error', message: err.message, screenshotPath };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { runBookingJob };

// Allow direct invocation: node src/bot/register-pilates.js
if (require.main === module) {
  runBookingJob({ classTitle: 'Core Pilates' }).then(result => {
    console.log(result.message);
    if (result.screenshotPath) console.log('Screenshot:', result.screenshotPath);
    if (result.status !== 'success') process.exit(1);
  });
}
