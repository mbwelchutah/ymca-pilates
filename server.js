const http = require('http');
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

const CHROMIUM_PATH = (() => {
  try { return execSync('which chromium').toString().trim(); } catch {}
  try { return execSync('which chromium-browser').toString().trim(); } catch {}
  return null;
})();

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

  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
    const page = await browser.newPage();

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
      // Strategy: search by class name + instructor, not by time text.
      // The schedule page splits "7:45 a" across separate DOM elements so
      // no single node ever contains that string.
      //
      // Algorithm:
      //  1. Clear any stale markers from prior calls.
      //  2. Find every element whose direct text-node content is exactly
      //     "Core Pilates" (which naturally excludes "Core Pilates Level 2").
      //  3. Walk UP from each such title element until we find an ancestor
      //     whose DIRECT children include (a) the title in one child and
      //     (b) "stephanie" text in a SEPARATE child — that separate child
      //     is the session row.
      //  4. Mark that session-row child so Playwright can locate it.
      const matched = await page.evaluate(() => {
        // Clear stale markers from any previous call
        document.querySelectorAll('[data-target-class]').forEach(el => {
          el.removeAttribute('data-target-class');
        });

        // Collect all elements whose own direct text nodes say "Core Pilates"
        const titleEls = [];
        for (const el of document.querySelectorAll('*')) {
          const directText = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent.trim())
            .filter(t => t.length > 0)
            .join('');
          if (/^core pilates$/i.test(directText)) titleEls.push(el);
        }

        for (const titleEl of titleEls) {
          // Walk up from the title element looking for the card container.
          // The card container is the lowest ancestor where the title element
          // and a "Stephanie" element live in SEPARATE direct children.
          let ancestor = titleEl.parentElement;
          while (ancestor && ancestor !== document.body) {
            let titleChild = null;   // direct child that contains titleEl
            let stephanieChild = null; // separate direct child with "stephanie"

            for (const child of Array.from(ancestor.children)) {
              if (child === titleEl || child.contains(titleEl)) {
                titleChild = child;
              } else if (child.textContent.toLowerCase().includes('stephanie')) {
                stephanieChild = child;
              }
            }

            if (titleChild && stephanieChild) {
              // stephanieChild is the session row for this Core Pilates class
              stephanieChild.setAttribute('data-target-class', 'yes');
              return stephanieChild.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
            }

            ancestor = ancestor.parentElement;
          }
        }
        return null;
      });

      if (matched) {
        log('  Matched row: ' + matched);
        return page.locator('[data-target-class="yes"]').first();
      }

      // Debug: log relevant lines from page
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const relevant = bodyText.split('\n').filter(l => l.match(/stephanie|core pilates/i)).slice(0, 8);
      log('  Page snippets: ' + (relevant.join(' | ') || '(none)'));
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
    if (browser) await browser.close();
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
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, log: 'Server error: ' + err.message }));
    } finally {
      running = false;
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, HOST, () => console.log('Server running on ' + HOST + ':' + PORT));
