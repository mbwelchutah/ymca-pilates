const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('https://my.familyworks.app');

  // Log in
  await page.fill('input[type="email"]', process.env.YMCA_EMAIL);
  await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForNavigation();

  // Navigate to class schedule
  await page.goto('https://my.familyworks.app/schedule');

  // Find and click Core Pilates on Tuesday at 4:20 PM
  const classEntry = page.locator('text=Core Pilates').filter({ hasText: '4:20' });
  await classEntry.first().click();

  // Click Register or Enroll button
  await page.locator('button:has-text("Register"), button:has-text("Enroll")').first().click();

  console.log('Registration complete!');
  await browser.close();
})();
