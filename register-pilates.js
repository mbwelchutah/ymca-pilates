const { chromium } = require('playwright');

const DRY_RUN = process.env.DRY_RUN === '1';
if (DRY_RUN) console.log('--- DRY RUN MODE: will not click Register/Waitlist ---');

(async () => {
  const browser = await chromium.launch({ headless: !DRY_RUN });
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
    // Strategy: search by class name + instructor, not by time text.
    // The schedule page splits "7:45 a" across separate DOM elements so
    // no single node ever contains that string.
    //
    // Algorithm:
    //  1. Clear stale markers from prior calls.
    //  2. Find elements whose direct text-node content is exactly "Core Pilates".
    //  3. Walk UP from each title element until an ancestor has the title in
    //     one direct child and "stephanie" in a SEPARATE direct child.
    //  4. Mark that session-row child for Playwright to locate and click.
    const matched = await page.evaluate(() => {
      document.querySelectorAll('[data-target-class]').forEach(el => {
        el.removeAttribute('data-target-class');
      });

      const titleEls = [];
      for (const el of document.querySelectorAll('*')) {
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .filter(t => t.length > 0)
          .join('');
        if (/^core pilates$/i.test(directText)) titleEls.push(el);
      }

      for (const titleEl of titleEls) {
        let ancestor = titleEl.parentElement;
        while (ancestor && ancestor !== document.body) {
          let titleChild = null;
          let stephanieChild = null;

          for (const child of Array.from(ancestor.children)) {
            if (child === titleEl || child.contains(titleEl)) {
              titleChild = child;
            } else if (child.textContent.toLowerCase().includes('stephanie')) {
              stephanieChild = child;
            }
          }

          if (titleChild && stephanieChild) {
            stephanieChild.setAttribute('data-target-class', 'yes');
            return stephanieChild.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
          }

          ancestor = ancestor.parentElement;
        }
      }
      return null;
    });

    if (matched) {
      console.log('Found Core Pilates / Stephanie row:', matched);
      return page.locator('[data-target-class="yes"]').first();
    }
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
    console.log('Could not find 7:45 AM Core Pilates with Stephanie on any Wednesday. Exiting.');
    await browser.close();
    process.exit(1);
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
    console.log('FAILED: Registration did not open within 10 minutes.');
    process.exit(1);
  }

  await browser.close();
})();
