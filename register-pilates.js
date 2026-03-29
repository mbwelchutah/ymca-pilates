const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();

   // Step 1: Go to YMCA app login page (with logout=yes to clear session)
   await page.goto('https://my.familyworks.app/m?p=login&logout=yes');
    await page.waitForLoadState('networkidle');

   // Step 2: Click "Login to Y Account" button
   await page.getByText('Login to Y Account').click();

   // Step 3: Wait for redirect to Daxko login page
   await page.waitForURL('**/daxko.com/**');
    await page.waitForSelector('input');

   // Step 4: Fill in email/phone field and submit
   await page.fill('input', process.env.YMCA_EMAIL);
    await page.getByRole('button', { name: /submit/i }).click();

   // Step 5: Fill in password and log in
   await page.waitForSelector('input[type="password"]');
    await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();

   // Step 6: Wait to land back on YMCA app
   await page.waitForURL('**/familyworks.app/**');
    await page.waitForLoadState('networkidle');

   // Step 7: Go to activities/schedule page
   await page.goto('https://my.familyworks.app/m?p=activities');
    await page.waitForLoadState('networkidle');

   // Step 8: Find Core Pilates at 4:20 PM and click it
   const classEntry = page.locator('text=Core Pilates').filter({ hasText: '4:20' });
    await classEntry.first().click();

   // Step 9: Click Register or Enroll button
   await page.locator('button:has-text("Register"), button:has-text("Enroll")').first().click();

   console.log('Registration complete!');
    await browser.close();
})();
