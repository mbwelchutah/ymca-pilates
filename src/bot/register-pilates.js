// Bot entry point — run by GitHub Actions every Sunday at 2:45 PM UTC.
// Logs into Daxko, finds the Wednesday Core Pilates class with Stephanie
// Sanders, and registers (or joins the waitlist). Set DRY_RUN=1 to run
// with a visible browser without clicking Register/Waitlist.
const fs = require('fs');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const isHeadless = process.env.HEADLESS !== 'false';

// Use the system Chromium (installed via Nix) so the required shared libraries
// (libgbm, libglib, etc.) are available. Playwright's bundled chrome-headless-shell
// cannot find them in this environment.
let CHROMIUM_PATH;
try {
  CHROMIUM_PATH = execSync('which chromium', { encoding: 'utf8' }).trim();
} catch {
  CHROMIUM_PATH = null;
}

async function runBookingJob(job, opts = {}) {
  const DRY_RUN = opts.dryRun !== undefined ? !!opts.dryRun : (process.env.DRY_RUN === '1');
  if (DRY_RUN) console.log('--- DRY RUN MODE: will not click Register/Waitlist ---');
  const { classTitle, classTime, instructor, dayOfWeek, targetDate, maxAttempts: maxAttemptsOpt } = job;
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
  // First name only for fuzzy instructor matching ("Stephanie Sanders" → "stephanie")
  const instructorFirstName = instructor
    ? instructor.trim().split(/\s+/)[0].toLowerCase()
    : 'stephanie';
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

    console.log(`Looking for: "${classTitle}" on ${dayOfWeek || 'any day'} at "${classTime || 'any time'}" (normalized: "${classTimeNorm || 'n/a'}")`);

    // Step 3: Find the target class card.
    // Strategy: time is primary discriminator; instructor first name is secondary.
    // Class title match is optional — the YMCA embed does not always render it near the row.
    // Algorithm: collect every element whose text contains both the normalized time string
    // and the instructor's first name; pick the smallest such element (shortest textContent
    // = most specific container); that element is the row to click.
    async function findTargetCard() {
      const result = await page.evaluate(({ classTimeNorm, instructorFirstName, classTitleLower }) => {
        document.querySelectorAll('[data-target-class]').forEach(el => {
          el.removeAttribute('data-target-class');
        });

        // Collect every element matching time + instructor first name.
        const candidates = [];
        for (const el of document.querySelectorAll('*')) {
          const txt = el.textContent.toLowerCase();
          if (classTimeNorm && !txt.includes(classTimeNorm)) continue;
          if (!txt.includes(instructorFirstName)) continue;
          candidates.push(el);
        }

        // Debug: if no candidates, dump all elements containing the time string.
        if (candidates.length === 0) {
          const timeEls = [];
          for (const el of document.querySelectorAll('*')) {
            if (classTimeNorm && el.textContent.toLowerCase().includes(classTimeNorm)) {
              timeEls.push(el.textContent.replace(/\s+/g, ' ').trim().slice(0, 100));
            }
          }
          return {
            matched: null,
            debug: {
              candidateCount: 0,
              timeElTexts: timeEls.slice(0, 6),
              classTimeNorm,
              instructorFirstName,
            }
          };
        }

        // Pick the most specific match — smallest textContent (fewest characters).
        candidates.sort((a, b) => a.textContent.length - b.textContent.length);
        const best = candidates[0];

        // Soft title check — log if missing but don't reject.
        const titlePresent = classTitleLower ? best.textContent.toLowerCase().includes(classTitleLower) : true;

        best.setAttribute('data-target-class', 'yes');
        return {
          matched: best.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
          titlePresent,
          debug: null,
        };
      }, { classTimeNorm, instructorFirstName, classTitleLower });

      if (result.matched) {
        if (result.titlePresent === false) {
          console.log(`⚠️  Class title "${classTitle}" not found in matched row — matched by time+instructor`);
        }
        console.log('Matched row:', result.matched);
        return page.locator('[data-target-class="yes"]').first();
      }

      if (result.debug) {
        console.log('findTargetCard: no match. debug =', JSON.stringify(result.debug));
        if (result.debug.timeElTexts && result.debug.timeElTexts.length > 0) {
          console.log('Elements containing time string:');
          result.debug.timeElTexts.forEach(t => console.log(' ', t));
        } else {
          console.log('No elements found containing time string:', classTimeNorm);
        }
      }
      return null;
    }

    // Step 3: Find the target day tab then find the class card within it.
    const dayTabs = page.locator(`text=/${dayShort} \\d+/`);
    const dayTabCount = await dayTabs.count();
    console.log(`Searching ${dayTabCount} "${dayShort}" tab(s) on the schedule page.`);
    let targetCard = null;

    // Helper: scan a set of day-tab locators and return the first card match.
    async function scanTabs(tabs, count) {
      for (let w = 0; w < count; w++) {
        const tabText = await tabs.nth(w).textContent();
        console.log('Trying tab: ' + tabText.trim());
        await tabs.nth(w).click();
        await page.waitForTimeout(2000);
        const card = await findTargetCard();
        if (card) { console.log('Found class on ' + tabText.trim()); return card; }
        console.log('Class not found on ' + tabText.trim() + ', trying next tab...');
      }
      return null;
    }

    // If targetDate is set, click that specific date tab first (faster and unambiguous).
    // Fall back to scanning all matching day tabs if the exact tab isn't visible yet.
    if (targetDayNum !== null) {
      let exactTabClicked = false;
      for (let w = 0; w < dayTabCount; w++) {
        const tabText = await dayTabs.nth(w).textContent();
        const tabNum  = parseInt(tabText.replace(/\D+/g, ''), 10);
        if (tabNum === targetDayNum) {
          console.log('Clicking exact date tab: ' + tabText.trim());
          await dayTabs.nth(w).click();
          await page.waitForTimeout(2000);
          targetCard = await findTargetCard();
          if (targetCard) console.log('Found class on exact date tab: ' + tabText.trim());
          else            console.log('Class not on exact date tab — falling back to full scan.');
          exactTabClicked = true;
          break;
        }
      }
      if (!exactTabClicked) {
        console.log(`Exact tab for day ${targetDayNum} not visible — falling back to full scan.`);
      }
    }

    // Fallback: scan all matching day tabs in order (also the path when targetDate is absent).
    if (!targetCard) {
      targetCard = await scanTabs(dayTabs, dayTabCount);
    }

    if (!targetCard) {
      const msg = `Could not find class at ${classTime || 'target time'} with instructor ${instructor || 'Stephanie'} on any ${dayOfWeek || dayShort} tab.`;
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

        // Re-find the correct day tab after reload, using exact-date if available.
        const dayTabsRetry    = page.locator(`text=/${dayShort} \\d+/`);
        const dayTabCountRetry = await dayTabsRetry.count();
        if (targetDayNum !== null) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            const tabText = await dayTabsRetry.nth(w).textContent();
            if (parseInt(tabText.replace(/\D+/g, ''), 10) === targetDayNum) {
              await dayTabsRetry.nth(w).click();
              await page.waitForTimeout(2000);
              targetCard = await findTargetCard();
              break;
            }
          }
        }
        if (!targetCard) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            await dayTabsRetry.nth(w).click();
            await page.waitForTimeout(2000);
            targetCard = await findTargetCard();
            if (targetCard) break;
          }
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
