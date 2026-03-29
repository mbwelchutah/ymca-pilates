const { chromium } = require('playwright');

(async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();

   // Step 1: Go directly to Daxko login page (bypasses Bubble.js FamilyWorks splash)
   await page.goto('https://operations.daxko.com/online/3100/Security/login.mvc/find_account?return_url=%2Fonline%2F3100%2F');
      await page.waitForLoadState('domcontentloaded');

   // Step 2: Fill in email and submit
   await page.waitForSelector('input');
      await page.fill('input', process.env.YMCA_EMAIL);
      await page.click('button[type="submit"], input[type="submit"]');

   // Step 3: Fill in password and log in
   await page.waitForSelector('input[type="password"]');
      await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
      await page.click('button[type="submit"], input[type="submit"]');

   // Step 4: Wait to land on the YMCA portal after login
   await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

   // Step 5: Go to the schedule embed page
   await page.goto('https://my.familyworks.app/schedulesembed-week-view');
      await page.waitForLoadState('networkidle');

   // Step 6: Find Core Pilates at 4:20 PM and click it
   const classEntry = page.locator('text=Core Pilates').filter({ hasText: '4:20' });
      await classEntry.first().click();

   // Step 7: Click Register or Enroll button
   await page.locator('button:has-text("Register"), button:has-text("Enroll"), button:has-text("Sign Up")').first().click();

   console.log('Registration complete!');
      await browser.close();
})();
