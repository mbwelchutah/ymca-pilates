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

   // Click Login and wait for URL to leave the login pages
   await Promise.all([
                   page.waitForURL(url => {
                                     const s = url.toString();
                                     return !s.includes('find_account') && !s.includes('/login');
                   }, { timeout: 30000 }),
                   page.click('#submit_button'),
                 ]);

   // Step 4: Go to schedule filtered to Core Pilates with Stephanie Sanders
   await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes&eventname=core+pilates&instructor=Stephanie+Sanders');
              await page.waitForLoadState('networkidle');
              await page.waitForTimeout(3000); // let Bubble.js render

   // Step 5: Click Wednesday's date tab (format: "Wed 01", "Wed 08", etc.)
   const wedTabs = page.locator('text=/Wed \\d+/');
              await wedTabs.first().click();
              await page.waitForTimeout(2000);

   // Step 6: Find Core Pilates at 7:45 AM with Stephanie
   // Card text format: "Core Pilates Yoga Studio • Eugene Y 7:45 a - 8:45 a Stephanie S."
   const cards = page.locator('text=Core Pilates');
              const count = await cards.count();
              let targetCard = null;

   for (let i = 0; i < count; i++) {
                   const card = cards.nth(i);
                   const p = await card.evaluateHandle(el => {
                                     let node = el;
                                     for (let j = 0; j < 4; j++) if (node.parentElement) node = node.parentElement;
                                     return node;
                   });
                   const cardText = await p.evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
                   if (cardText.includes('7:45') && cardText.toLowerCase().includes('stephanie')) {
                                     targetCard = card;
                                     break;
                   }
   }

   if (!targetCard) {
                   console.log('Could not find Wednesday 7:45 AM Core Pilates with Stephanie. Exiting.');
                   await browser.close();
                   process.exit(1);
   }

   await targetCard.click();
              await page.waitForTimeout(2000);

   // Step 7: Register or join waitlist if full
   const registerBtn = page.locator('button:has-text("Register"), button:has-text("Enroll"), button:has-text("Sign Up")');
              const waitlistBtn = page.locator('button:has-text("Waitlist"), button:has-text("Join Waitlist"), button:has-text("Wait List")');

   const hasRegister = await registerBtn.count() > 0;
              const hasWaitlist = await waitlistBtn.count() > 0;

   if (hasRegister) {
                   await registerBtn.first().click();
                   console.log('Registered for Core Pilates Wed 7:45 AM with Stephanie!');
   } else if (hasWaitlist) {
                   await waitlistBtn.first().click();
                   console.log('Class full — joined waitlist for Core Pilates Wed 7:45 AM with Stephanie.');
   } else {
                   console.log('No Register or Waitlist button found. May already be booked.');
                   process.exit(1);
   }

   await browser.close();
})();
