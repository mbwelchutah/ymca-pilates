const { chromium } = require('playwright');

(async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();

   // Step 1: Go directly to Daxko login page
   await page.goto('https://operations.daxko.com/online/3100/Security/login.mvc/find_account?return_url=%2Fonline%2F3100%2F');
      await page.waitForLoadState('domcontentloaded');

   // Step 2: Fill in email and submit
   await page.waitForSelector('input[type="text"]:visible, input[type="email"]:visible, input[type="tel"]:visible');
      await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
      await page.click('#submit_button');

   // Step 3: Fill in password and click Login (not "Get Code")
   await page.waitForSelector('input[type="password"]');
      await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);

   // Click Login and wait for URL to change away from the login page
   await Promise.all([
           page.waitForURL(url => {
                     const s = url.toString();
                     return !s.includes('find_account') && !s.includes('/login');
           }, { timeout: 30000 }),
           page.click('#submit_button'),
         ]);

   // Step 4: Go to the schedule embed page and wait for it to fully render
   await page.goto('https://my.familyworks.app/schedulesembed-week-view');
      await page.waitForLoadState('networkidle');
      // Extra wait for Bubble.js dynamic content to render
   await page.waitForTimeout(5000);

   // Step 5: Find Core Pilates on Tuesday at 4:20 PM
   // Look for the class card containing both "Core Pilates" and "4:20"
   const classCard = page.locator('.event_occurrence_result, [class*="event"], [class*="class"]')
        .filter({ hasText: 'Core Pilates' })
        .filter({ hasText: '4:20' })
        .first();

   // Fallback: just find any element with both texts
   const fallback = page.getByText(/Core Pilates/i).first();

   const count = await classCard.count();
      if (count > 0) {
              await classCard.click();
      } else {
              await fallback.click();
      }

   // Step 6: Click Register or Enroll button
   await page.waitForTimeout(2000);
      await page.locator('button:has-text("Register"), button:has-text("Enroll"), button:has-text("Sign Up"), button:has-text("Add")').first().click();

   console.log('Registration complete!');
      await browser.close();
})();
