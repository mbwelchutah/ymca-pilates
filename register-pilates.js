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
  await page.locator(const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Step 1: Go to YMCA app and click Login
  await page.goto('https://my.familyworks.app/m?p=login&logout=yes');
  await page.waitForLoadState('networkidle');
  await page.getByText('Login to Y Account').click();

  // Step 2: On Daxko login page - enter email
  await page.waitForURL('**/daxko.com/**');
  await page.waitForSelector('input[type="text"], input[type="email"], input[type="tel"]');
  await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
  await page.getByRole('button', { name: /submit/i }).click();

  // Step 3: Enter password
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();

  // Step 4: Wait to land back on YMCA app
  await page.waitForURL('**/familyworks.app/**');
  await page.waitForLoadState('networkidle');

  // Step 5: Navigate to schedule and find Core Pilates Tuesday 4:20 PM
  await page.goto('https://my.familyworks.app/m?p=activities');
  await page.waitForLoadState('networkidle');

  const classEntry = page.locator('text=Core Pilates').filter({ hasText: '4:20' });
  await classEntry.first().click();

  // Step 6: Click Register or Enroll
  await page.locator('button:has-text("Register"), button:has-text("Enroll")').first().click();

  console.log('Registration complete!');
  await browser.close();
})();button:has-text("Register"), button:has-text("Enroll")').first().click();

  console.log('Registration complete!');
  await browser.close();
})();
