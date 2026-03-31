// Bot entry point — run by GitHub Actions every Sunday at 2:45 PM UTC.
// Logs into Daxko, finds the Wednesday Core Pilates class with Stephanie
// Sanders, and registers (or joins the waitlist). Set DRY_RUN=1 to run
// with a visible browser without clicking Register/Waitlist.
const { chromium } = require('playwright');

const DRY_RUN = process.env.DRY_RUN === '1';
if (DRY_RUN) console.log('--- DRY RUN MODE: will not click Register/Waitlist ---');

async function runBookingJob(job) {
  const { classTitle } = job;
  let browser;
  const screenshotPath = null; // reserved for future screenshot support

  try {
    browser = await chromium.launch({ headless: !DRY_RUN });
    const page = await browser.newPage();

    // Step 1: Log in via Daxko
    await page.goto('https://operations.daxko.com/online/3100/Security/login.mvc/find_account');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('input[type="text"]:visible, input[type="email"]:visible');
    await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
    await page.click('#submit_button');
    await page.waitForSelector('input[type="password"]');
    await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
    await Promise.all([
      page.waitForURL(url => {
        const s = url.toString();
        return !s.includes('find_account') && !s.includes('/login');
      }, { timeout: 30000 }),
      page.click('#submit_button'),
    ]);

    // Step 2: Go to schedule and filter by Stephanie Sanders instructor
    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4000);

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

    // Step 3: Find Core Pilates at 7:45 AM with Stephanie on the next available Wednesday
    async function findTargetCard() {
      // Strategy: start from "Stephanie S." text, walk UP to find the class card
      // that contains "Core Pilates" but NOT "Core Pilates Level 2", then walk
      // back down to get the direct-child session row to click.
      //
      // The previous approach (start from "Core Pilates" title, look for a separate
      // "Stephanie" sibling in an ancestor's direct children) never worked because
      // the title and the session row are both INSIDE the same class card — they
      // are never in separate direct children of any ancestor.
      const result = await page.evaluate(() => {
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

        for (const stephanieEl of stephanieEls) {
          let ancestor = stephanieEl.parentElement;
          while (ancestor && ancestor !== document.body) {
            const txt = ancestor.textContent;
            // First ancestor with "Core Pilates" but NOT "Level 2" = the class card
            if (/core pilates/i.test(txt) && !/core pilates level 2/i.test(txt)) {
              // Trace back from stephanieEl to its direct-child-of-ancestor level
              let clickTarget = stephanieEl;
              while (clickTarget.parentElement && clickTarget.parentElement !== ancestor) {
                clickTarget = clickTarget.parentElement;
              }
              if (clickTarget.parentElement === ancestor) {
                clickTarget.setAttribute('data-target-class', 'yes');
                return {
                  matched: clickTarget.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
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
          debug: {
            stephanieElCount: stephanieEls.length,
            stephanieTexts: stephanieEls.slice(0, 4).map(el =>
              el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
          }
        };
      });

      if (result.matched) {
        console.log('Found Core Pilates / Stephanie row:', result.matched);
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
      return { status: 'error', message: msg, screenshotPath };
    }

    await targetCard.click();
    await page.waitForTimeout(2000);

    // Step 5: Try to register — retry every 30s for up to 10 minutes if not open yet
    const maxAttempts = 20;
    let registered = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const registerBtn = page.locator('button:has-text("Register")');
      const waitlistBtn = page.locator('button:has-text("aitlist")');
      const hasRegister = await registerBtn.count() > 0;
      const hasWaitlist = await waitlistBtn.count() > 0;

      // Log all visible buttons for debugging
      const allBtns = await page.locator('button:visible').allTextContents();
      console.log('Attempt ' + attempt + ': visible buttons: ' + JSON.stringify(allBtns));

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
      return { status: 'error', message: msg, screenshotPath };
    }

    const successMsg = DRY_RUN
      ? `DRY RUN complete for ${classTitle}`
      : `Registered for ${classTitle} with Stephanie`;
    return { status: 'success', message: successMsg, screenshotPath };

  } catch (err) {
    console.error('❌ Error:', err.message);
    return { status: 'error', message: err.message, screenshotPath };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { runBookingJob };
