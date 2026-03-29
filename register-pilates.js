const { chromium } = require('playwright');

(async () => {
        const browser = await chromium.launch();
        const page = await browser.newPage();

   // Step 1: Hit Daxko login directly — no cookie means Playwright starts fresh.
   // After successful login, Daxko redirects back to FamilyWorks automatically.
   await page.goto('https://operations.daxko.com/online/3100/Security/login.mvc/find_account?return_url=%2Fonline%2F3100%2F');

   // Step 2: Fill email and submit
   await page.waitForSelector('input[type="text"], input[type="email"], input[type="tel"]', { timeout: 15000 });
        const emailInput = page.locator('input[type="text"], input[type="email"], input[type="tel"]').first();
        await emailInput.fill(process.env.YMCA_EMAIL);
        await page.locator('button[type="submit"]').click();

   // Step 3: Fill password and log in
   await page.waitForSelector('input[type="password"]', { timeout: 15000 });
        await page.locator('input[type="password"]').fill(process.env.YMCA_PASSWORD);
        await page.locator('button[type="submit"]').click();

   // Step 4: Daxko redirects back to FamilyWorks — wait for it
   await page.waitForURL('**/familyworks.app/**', { timeout: 30000 });
        await page.waitForLoadState('networkidle');

   // Step 5: Navigate to the schedule embed page
   await page.goto('https://my.familyworks.app/schedulesembed-week-view');
        await page.waitForLoadState('networkidle');

   // Step 6: Find Core Pilates at 4:20 PM and click it
   const classEntry = page.locator('text=Core Pilates').filter({ hasText: '4:20' });
        await classEntry.first().click({ timeout: 30000 });

   // Step 7: Click the registration button
   await page.locator('button:has-text("Register"), button:has-text("Enroll"), button:has-text("Sign Up")').first().click({ timeout: 15000 });

   console.log('Registration complete!');
        await browser.close();
})();
