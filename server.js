const http = require('http');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YMCA Pilates Registration</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f4f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      text-align: center;
    }
    h1 { font-size: 24px; color: #1a1a2e; margin-bottom: 6px; }
    .subtitle { color: #666; font-size: 15px; margin-bottom: 32px; }
    button {
      background: #e63946;
      color: white;
      border: none;
      border-radius: 12px;
      padding: 16px 40px;
      font-size: 17px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s;
    }
    button:hover { background: #c1121f; }
    button:disabled { background: #aaa; cursor: not-allowed; }
    #status {
      margin-top: 24px;
      padding: 16px;
      border-radius: 10px;
      font-size: 14px;
      line-height: 1.6;
      text-align: left;
      display: none;
      white-space: pre-wrap;
      font-family: monospace;
      background: #f8f9fa;
      border: 1px solid #e0e0e0;
      max-height: 300px;
      overflow-y: auto;
    }
    .success { background: #d4edda; border-color: #c3e6cb; color: #155724; }
    .error   { background: #f8d7da; border-color: #f5c6cb; color: #721c24; }
    .running { background: #fff3cd; border-color: #ffeeba; color: #856404; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🧘 YMCA Pilates</h1>
    <p class="subtitle">Core Pilates · Wed 7:45 AM · Stephanie</p>
    <button id="btn" onclick="register()">Register Me</button>
    <div id="status"></div>
  </div>
  <script>
    async function register() {
      const btn = document.getElementById('btn');
      const status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Running...';
      status.className = 'running';
      status.style.display = 'block';
      status.textContent = 'Starting registration...';

      try {
        const res = await fetch('/register');
        const data = await res.json();
        status.textContent = data.log;
        if (data.success) {
          status.className = 'success';
          btn.textContent = '✅ Registered!';
        } else {
          status.className = 'error';
          btn.textContent = 'Try Again';
          btn.disabled = false;
        }
      } catch (e) {
        status.className = 'error';
        status.textContent = 'Network error: ' + e.message;
        btn.textContent = 'Try Again';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

let running = false;

async function runRegistration() {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Step 1: Log in
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
    log('✅ Logged in');

    // Step 2: Go to schedule
    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes&event=Core Pilates');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    log('✅ Schedule loaded');

    // Step 3: Find class
    async function findTargetCard() {
      const timeSlots = page.locator('text=/7:45 a/');
      const count = await timeSlots.count();
      for (let i = 0; i < count; i++) {
        const el = timeSlots.nth(i);
        const rowHandle = await el.evaluateHandle(node => {
          let n = node;
          for (let j = 0; j < 6; j++) {
            if (n.parentElement) n = n.parentElement;
            if (n.textContent.toLowerCase().includes('stephanie')) return n;
          }
          return null;
        });
        const isValid = await rowHandle.evaluate(n => n !== null).catch(() => false);
        if (isValid) return el;
      }
      return null;
    }

    const wedTabs = page.locator('text=/Wed \\d+/');
    const wedCount = await wedTabs.count();
    let targetCard = null;

    for (let w = 0; w < wedCount; w++) {
      const tabText = await wedTabs.nth(w).textContent();
      log('Trying ' + tabText.trim() + '...');
      await wedTabs.nth(w).click();
      await page.waitForTimeout(2000);
      targetCard = await findTargetCard();
      if (targetCard) { log('✅ Found class on ' + tabText.trim()); break; }
    }

    if (!targetCard) {
      log('❌ Could not find class on any Wednesday');
      return { success: false, log: logs.join('\n') };
    }

    await targetCard.click();
    await page.waitForTimeout(2000);

    // Step 4: Register
    const maxAttempts = 20;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const registerBtn = page.locator('button:has-text("Register")');
      const waitlistBtn = page.locator('button:has-text("aitlist")');
      const hasRegister = await registerBtn.count() > 0;
      const hasWaitlist = await waitlistBtn.count() > 0;
      const allBtns = await page.locator('button:visible').allTextContents();
      log('Attempt ' + attempt + ': buttons: ' + JSON.stringify(allBtns));

      if (hasRegister) {
        await registerBtn.first().click();
        log('✅ SUCCESS: Registered for Core Pilates 7:45 AM with Stephanie!');
        return { success: true, log: logs.join('\n') };
      } else if (hasWaitlist) {
        await waitlistBtn.first().click();
        log('✅ WAITLIST: Joined waitlist for Core Pilates 7:45 AM');
        return { success: true, log: logs.join('\n') };
      } else {
        log('Attempt ' + attempt + ': not open yet, retrying in 30s...');
        await page.waitForTimeout(30000);
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);
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

    log('❌ Registration did not open within 10 minutes');
    return { success: false, log: logs.join('\n') };

  } catch (err) {
    log('❌ Error: ' + err.message);
    return { success: false, log: logs.join('\n') };
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (req.method === 'GET' && req.url === '/register') {
    if (running) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, log: 'Already running, please wait...' }));
      return;
    }
    running = true;
    try {
      const result = await runRegistration();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } finally {
      running = false;
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, HOST, () => console.log('Server running on ' + HOST + ':' + PORT));
