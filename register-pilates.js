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

   // Click Login and wait for URL to leave login pages (URL object, must use .toString())
   await Promise.all([
             page.waitForURL(url => {
                         const s = url.toString();
                         return !s.includes('find_account') && !s.includes('/login');
             }, { timeout: 30000 }),
             page.click('#submit_button'),
           ]);

   // Step 4: Go to the schedule embed page
   await page.goto('https://my.familyworks.app/schedulesembed-week-view');
        await page.waitForLoadState('networkidle');

   // Step 5: Find Core Pilates near 4:20 pm on Tuesday
   // The schedule shows class name and time in separate elements — find the card containing both
   const classEntry = page.locator('text=Core Pilates').filter({ hasText: /4:20/ });
        await classEntry.first().click({ timeout: 30000 });

   // Step 6: Click Register or Enroll button
   await page.locator('button:has-text("Register"), button:has-text("Enroll"), button:has-text("Sign Up")').first().click();

   console.log('Registration complete!');
        await browser.close();
})();
