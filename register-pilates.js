const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
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

  // Step 2: Go to Core Pilates schedule search
  await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes&event=Core Pilates');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // Step 3: Find Core Pilates at 7:45 AM with Stephanie on the next available Wednesday
  async function findTargetCard() {
    const cards = page.locator('text=Core Pilates');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const p = await card.evaluateHandle(el => {
        let node = el;
        for (let j = 0; j < 4; j++) node = node.parentElement;
        return node;
      });
      const cardText = await p.evaluate(el => el.textContent.replace(/\s+/g, ' '));
      if (cardText.includes('7:45') && cardText.toLowerCase().includes('stephanie')) {
        return card;
      }
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
      await registerBtn.first().click();
      console.log('SUCCESS: Registered for Core Pilates 7:45 AM with Stephanie');
      registered = true;
      break;
    } else if (hasWaitlist) {
      await waitlistBtn.first().click();
      console.log('WAITLIST: Class full — joined waitlist for Core Pilates 7:45 AM');
      registered = true;
      break;
    } else {
      console.log('Attempt ' + attempt + ': No register/waitlist button found. Retrying in 30s...');
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
