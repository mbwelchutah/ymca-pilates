// Bot entry point — run by GitHub Actions every Sunday at 2:45 PM UTC.
// Logs into Daxko, finds the Wednesday Core Pilates class with Stephanie
// Sanders, and registers (or joins the waitlist). Set DRY_RUN=1 to run
// with a visible browser without clicking Register/Waitlist.
const fs = require('fs');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const isHeadless = process.env.HEADLESS !== 'false';

// Set to false to skip visual highlights in production.
// When true, the bot outlines the click target in the live browser and
// appends a floating "CLICK TARGET" label — both visible in screenshots.
const DEBUG_HIGHLIGHT = true;

// Set to true (+ run with HEADLESS=false) to open Playwright Inspector just
// before the card click. page.pause() is a no-op in headless mode, so this
// has zero effect on normal / production runs even if accidentally left true.
const DEBUG_PAUSE = false;

async function highlightElement(page, locator) {
  try {
    const el = await locator.elementHandle();
    if (!el) return;
    await page.evaluate((node) => {
      node.style.outline = '3px solid red';
      node.style.backgroundColor = 'rgba(255,0,0,0.1)';
      node.style.transition = 'all 0.2s ease';
      // Floating label so it shows up clearly in screenshots.
      const tag = document.createElement('div');
      tag.className = '__pw_debug_label__';
      tag.textContent = 'CLICK TARGET';
      Object.assign(tag.style, {
        position: 'fixed',
        background: 'red',
        color: 'white',
        fontSize: '11px',
        fontWeight: 'bold',
        padding: '2px 6px',
        borderRadius: '3px',
        zIndex: '999999',
        pointerEvents: 'none',
      });
      const rect = node.getBoundingClientRect();
      tag.style.top  = Math.max(0, rect.top  - 20) + 'px';
      tag.style.left = Math.max(0, rect.left)       + 'px';
      document.body.appendChild(tag);
    }, el);
  } catch (e) { console.log('highlight skipped:', e.message); }
}

// Use the system Chromium (installed via Nix) so the required shared libraries
// (libgbm, libglib, etc.) are available. Playwright's bundled chrome-headless-shell
// cannot find them in this environment.
let CHROMIUM_PATH;
try {
  CHROMIUM_PATH = execSync('which chromium', { encoding: 'utf8' }).trim();
} catch {
  CHROMIUM_PATH = null;
}

async function runBookingJob(job, opts = {}) {
  const DRY_RUN = opts.dryRun !== undefined ? !!opts.dryRun : (process.env.DRY_RUN === '1');
  if (DRY_RUN) console.log('--- DRY RUN MODE: will not click Register/Waitlist ---');
  const { classTitle, classTime, instructor, dayOfWeek, targetDate, maxAttempts: maxAttemptsOpt } = job;
  // Convert "Wednesday" → "Wed" to match tab labels like "Wed 02"
  const DAY_SHORT = {
    Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
    Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat',
  };
  let dayShort = DAY_SHORT[dayOfWeek] || 'Wed';

  // If targetDate is provided (YYYY-MM-DD), derive the exact day number and
  // override dayShort from the date itself (more reliable than the DB string).
  let targetDayNum = null;
  if (targetDate) {
    const d = new Date(targetDate + 'T00:00:00Z'); // parse as UTC to avoid tz shift
    dayShort     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    targetDayNum = d.getUTCDate(); // numeric day-of-month, e.g. 9
    console.log(`targetDate: ${targetDate} → looking for "${dayShort} ${targetDayNum}" tab`);
  }
  const classTitleLower = classTitle.toLowerCase();
  // Normalize DB time "7:45 AM" → "7:45 a" to match page text like "7:45 a - 8:45 a"
  const classTimeNorm = classTime
    ? classTime.trim().toLowerCase().replace(/^(\d+:\d+)\s*(am|pm).*/, (_, t, ap) => t + ' ' + ap[0])
    : null;
  // First name only for fuzzy instructor matching ("Stephanie Sanders" → "stephanie")
  const instructorFirstName = instructor
    ? instructor.trim().split(/\s+/)[0].toLowerCase()
    : 'stephanie';
  let browser;
  let screenshotPath = null;

  try {
    browser = await chromium.launch({
      headless: isHeadless,
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    });
    const page = await browser.newPage();

    const snap = async (label = '') => {
      try {
        const dir = 'screenshots';
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const suffix = label ? `-${label}` : '';
        const p = `${dir}/${ts}${suffix}.png`;
        await page.screenshot({ path: p, fullPage: true });
        screenshotPath = p;
        console.log('Screenshot saved:', p);
        // Keep only the 20 most recent screenshots to prevent disk bloat.
        const files = fs.readdirSync(dir)
          .map(name => ({ name, mtime: fs.statSync(require('path').join(dir, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        files.slice(20).forEach(f => {
          try { fs.unlinkSync(require('path').join(dir, f.name)); console.log('Deleted old screenshot:', f.name); }
          catch (_) {}
        });
      } catch (e) {
        console.log('Screenshot failed:', e.message);
      }
    };

    // Step 1: Log in via Daxko
    await page.goto('https://operations.daxko.com/online/3100/Security/login.mvc/find_account');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('input[type="text"]:visible, input[type="email"]:visible');
    await page.fill('input[type="text"], input[type="email"], input[type="tel"]', process.env.YMCA_EMAIL);
    await page.click('#submit_button');
    await page.waitForSelector('input[type="password"]');
    await page.fill('input[type="password"]', process.env.YMCA_PASSWORD);
    console.log('Submitting login...');
    await Promise.all([
      page.waitForURL(url => {
        const s = url.toString();
        return !s.includes('find_account') && !s.includes('/login');
      }, { timeout: 30000 }),
      page.click('#submit_button'),
    ]);
    console.log('Login submit complete. URL:', page.url());

    // Auth check: confirm we are no longer on a login page
    const postLoginUrl = page.url();
    const passwordFieldGone = await page.locator('input[type="password"]').count() === 0;
    const stillOnLogin = postLoginUrl.includes('/login') || postLoginUrl.includes('find_account');
    console.log('Password field gone:', passwordFieldGone, '| Still on login page:', stillOnLogin);
    if (stillOnLogin || !passwordFieldGone) {
      console.log('Login appears to have failed.');
      await snap();
      return { status: 'error', message: 'Login failed or session not established', screenshotPath };
    }
    console.log('Auth looks valid — proceeding.');

    // Step 2: Go to schedule and filter by Stephanie Sanders instructor
    console.log('Navigating to schedule...');
    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4000);
    console.log('Schedule loaded. URL:', page.url());

    // Auth check: if the schedule page is asking us to log in, session didn't carry over
    const loginPrompt = await page.locator('text=/login to register/i').count();
    if (loginPrompt > 0) {
      console.log('Schedule page shows "Login to Register" — session not established.');
      await snap();
      return { status: 'error', message: 'Session not established — schedule page requires login', screenshotPath };
    }
    console.log('Auth valid on schedule page — continuing.');

    // Wait for any dropdown to have options loaded (Bubble.io loads them async)
    await page.waitForFunction(() => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (sel.options.length > 1) return true;
      }
      return false;
    }, { timeout: 15000 }).catch(() => console.log('⚠️ Dropdown options slow to load, proceeding anyway'));

    // Log all selects and their options so we can see what filters are available.
    const allSelectInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map((sel, i) => ({
        index: i,
        options: Array.from(sel.options).map(o => o.text),
      }));
    });
    console.log('Available select dropdowns:', JSON.stringify(allSelectInfo));

    // Bubble.io ignores programmatic changes to hidden <select> elements.
    // Bubble.io dropdown strategy:
    //   1. The real <select> is hidden (display:none). Its PARENT is the visible pill.
    //   2. We click the parent wrapper to open the custom dropdown overlay.
    //   3. After the overlay appears, we find the first VISIBLE element whose text
    //      exactly matches the target value and click it.
    //   4. We do this for every filter regardless of the pill's current label, so a
    //      stale session filter that didn't trigger a re-render gets refreshed too.
    // Bubble.io dropdowns require a full pointer-event chain (pointerdown → mousedown
    // → mouseup → click).  JS element.click() only fires the click event and misses
    // pointerdown/mousedown, so Bubble's overlay never opens.
    // Fix: get the wrapper's Bubble.io class suffix (unique per element), then use
    // Playwright's native locator.click() which replays the full event sequence.
    async function applyFilterBySelectIndex(selectIndex, targetValue, filterLabel) {
      // Step 1: Walk up from the hidden <select> to find the INDIVIDUAL PILL wrapper.
      // Key: the pill contains exactly 1 <select>; the filter bar row contains all 4.
      // We use this to skip past the row and find the pill precisely.
      const pillInfo = await page.evaluate((idx) => {
        const sels = document.querySelectorAll('select');
        if (idx >= sels.length) return null;
        let el = sels[idx].parentElement;
        while (el && el !== document.body) {
          const r = el.getBoundingClientRect();
          const selectCount = el.querySelectorAll('select').length;
          // Valid pill: visible dimensions AND contains exactly this one select
          if (r.width > 20 && r.height > 10 && selectCount === 1) {
            const m = el.className.match(/\bcpi\w+\b/);
            return { cls: m ? m[0] : null, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
          }
          el = el.parentElement;
        }
        return null;
      }, selectIndex);

      if (!pillInfo || !pillInfo.cls) {
        console.log(`⚠️ Could not find individual pill for filter #${selectIndex} (${filterLabel}). pillInfo:`, pillInfo);
        return false;
      }
      console.log(`  Filter #${selectIndex} (${filterLabel}) pill: .${pillInfo.cls} ${pillInfo.w}×${pillInfo.h} @ (${pillInfo.x},${pillInfo.y}) — clicking...`);

      // Step 2: Playwright native click → fires full pointer-event chain Bubble.io needs.
      const trigger = page.locator(`.${pillInfo.cls}`).first();
      await trigger.waitFor({ state: 'visible' });
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      console.log(`  Clicked pill — waiting for "${targetValue}" option to become visible...`);

      // Step 3: Poll until a visible (rendered, non-option) element with targetValue appears.
      // Uses offsetWidth/offsetHeight which are 0 for display:none elements (hidden <option>).
      try {
        await page.waitForFunction((val) => {
          for (const el of document.querySelectorAll('*')) {
            if (el.tagName === 'OPTION' || el.tagName === 'SELECT') continue;
            if (el.textContent.trim() === val && el.offsetWidth > 0 && el.offsetHeight > 0)
              return true;
          }
          return false;
        }, targetValue, { timeout: 5000 });
        console.log(`  Option "${targetValue}" is now visible in the overlay.`);
      } catch {
        console.log(`⚠️ Timed out waiting for visible "${targetValue}" in dropdown.`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        return false;
      }

      // Step 4: Click the visible option (excluding hidden <option>/<select> elements).
      const allMatches = page.locator(`text=/^${targetValue.replace('/', '\\/')}$/`);
      const total = await allMatches.count();
      let clicked = false;
      for (let i = 0; i < total; i++) {
        const el = allMatches.nth(i);
        const tag = await el.evaluate(n => n.tagName);
        if (tag === 'OPTION' || tag === 'SELECT') continue;
        if (await el.isVisible()) {
          await el.scrollIntoViewIfNeeded();
          await el.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        console.log(`⚠️ Could not click visible "${targetValue}" — all matches were hidden.`);
        await page.keyboard.press('Escape');
        return false;
      }

      // Step 5: Verify the pill now shows the selected value.
      await page.waitForTimeout(2000);
      const pillText = await trigger.textContent().catch(() => '(unknown)');
      console.log(`✅ Filter #${selectIndex} (${filterLabel}) → "${targetValue}" | pill now shows: "${pillText.trim()}"`);
      return true;
    }

    // select index 0 = Category, index 2 = Instructor (confirmed from dropdown log above)
    const categoryApplied  = await applyFilterBySelectIndex(0, 'Yoga/Pilates',     'Category');
    const instructorApplied = await applyFilterBySelectIndex(2, 'Stephanie Sanders', 'Instructor');

    if (!categoryApplied)   console.log('⚠️ Category filter not applied — will scan all categories.');
    if (!instructorApplied) console.log('⚠️ Instructor filter not applied — will scan all instructors.');

    await page.waitForTimeout(1500); // let schedule re-render with both filters active

    console.log(`Looking for: "${classTitle}" on ${dayOfWeek || 'any day'} at "${classTime || 'any time'}" (normalized: "${classTimeNorm || 'n/a'}")`);

    // Step 3: Find the target class card.
    // Strategy: time is primary discriminator; instructor first name is secondary.
    // Class title match is optional — the YMCA embed does not always render it near the row.
    // Algorithm: collect every element whose text contains both the normalized time string
    // and the instructor's first name; pick the smallest such element (shortest textContent
    // = most specific container); that element is the row to click.
    async function findTargetCard() {
      const result = await page.evaluate(({ classTimeNorm, instructorFirstName, classTitleLower }) => {
        document.querySelectorAll('[data-target-class]').forEach(el => {
          el.removeAttribute('data-target-class');
        });

        // --- Primary match: time + instructor first name ---
        const candidates = [];
        for (const el of document.querySelectorAll('*')) {
          const txt = el.textContent.toLowerCase();
          if (classTimeNorm && !txt.includes(classTimeNorm)) continue;
          if (!txt.includes(instructorFirstName)) continue;
          candidates.push(el);
        }

        if (candidates.length > 0) {
          // Pick smallest (most specific) element.
          candidates.sort((a, b) => a.textContent.length - b.textContent.length);
          const best = candidates[0];
          const titlePresent = classTitleLower ? best.textContent.toLowerCase().includes(classTitleLower) : true;
          best.setAttribute('data-target-class', 'yes');
          return { matched: best.textContent.replace(/\s+/g, ' ').trim().slice(0, 120), titlePresent, fallback: null, debug: null };
        }

        // --- Fallback: find rows by AM/PM time pattern ---
        // Parse "H:MM a" or "H:MM p" → minutes since midnight for closest-time ranking.
        function parseMin(t) {
          const m = (t || '').match(/(\d+):(\d+)\s*([ap])/i);
          if (!m) return null;
          let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
          if (m[3].toLowerCase() === 'p' && h !== 12) h += 12;
          if (m[3].toLowerCase() === 'a' && h === 12) h = 0;
          return h * 60 + min;
        }
        const targetMin = parseMin(classTimeNorm);
        const timePattern = /\d+:\d+\s*[ap]\s*-\s*\d+:\d+\s*[ap]/i;

        // Collect leaf-ish elements that contain an AM/PM time range AND the instructor.
        // Requiring the instructor prevents the fallback from picking a completely wrong class.
        const rowEls = [];
        for (const el of document.querySelectorAll('*')) {
          if (!timePattern.test(el.textContent)) continue;
          if (el.querySelectorAll('*').length > 20) continue; // skip broad containers
          if (!el.textContent.toLowerCase().includes(instructorFirstName)) continue; // must have instructor
          rowEls.push(el);
        }

        const rowTexts = rowEls.map(el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 100));

        if (rowEls.length === 0) {
          return { matched: null, fallback: null, debug: { candidateCount: 0, timeElTexts: [], classTimeNorm, instructorFirstName } };
        }

        // Pick closest time to target; fall back to first instructor-matching row.
        let bestEl = rowEls[0];
        let bestDiff = Infinity;
        for (const el of rowEls) {
          if (targetMin === null) break; // no target time — use first row
          const rowMin = parseMin(el.textContent);
          if (rowMin === null) continue;
          const diff = Math.abs(rowMin - targetMin);
          if (diff < bestDiff) { bestDiff = diff; bestEl = el; }
        }

        // Refuse the fallback if the closest match is more than 2 hours away —
        // that means the class simply isn't on this tab, not that it's nearby.
        const MAX_DIFF = 120; // minutes
        if (targetMin !== null && bestDiff > MAX_DIFF) {
          const bestText = bestEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
          return {
            matched: null, fallback: null, debug: null,
            tooFar: { bestDiff, bestText, targetMin },
          };
        }

        bestEl.setAttribute('data-target-class', 'yes');
        return {
          matched: bestEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
          titlePresent: classTitleLower ? bestEl.textContent.toLowerCase().includes(classTitleLower) : true,
          fallback: targetMin !== null ? 'closest-time' : 'first-row',
          fallbackRowTexts: rowTexts,
          debug: null,
        };
      }, { classTimeNorm, instructorFirstName, classTitleLower });

      if (result.matched) {
        if (result.fallback) {
          console.log(`⚠️  Primary match failed — using ${result.fallback} fallback`);
          if (result.fallbackRowTexts) {
            console.log('Available rows on this tab:');
            result.fallbackRowTexts.forEach((t, i) => console.log(`  [${i}] ${t}`));
          }
        } else if (result.titlePresent === false) {
          console.log(`⚠️  Class title "${classTitle}" not in matched row — matched by time+instructor`);
        }
        console.log('Matched row:', result.matched);
        return page.locator('[data-target-class="yes"]').first();
      }

      if (result.tooFar) {
        const diffH = Math.round(result.tooFar.bestDiff / 60 * 10) / 10;
        console.log(`⚠️  Fallback refused — closest Stephanie class is ${diffH} hr(s) from target (${classTimeNorm}). Closest: "${result.tooFar.bestText}"`);
        console.log('   Class is not on this tab yet — registration may not be open.');
      }

      if (result.debug) {
        console.log('findTargetCard: no match.', JSON.stringify(result.debug));
        if (result.debug.timeElTexts && result.debug.timeElTexts.length > 0) {
          console.log('Elements containing time string:');
          result.debug.timeElTexts.forEach(t => console.log(' ', t));
        } else {
          console.log('No elements found matching time string:', classTimeNorm);
        }
      }
      return null;
    }

    // Step 3: Find the target day tab then find the class card within it.
    const dayTabs = page.locator(`text=/${dayShort} \\d+/`);
    const dayTabCount = await dayTabs.count();
    console.log(`Searching ${dayTabCount} "${dayShort}" tab(s) on the schedule page.`);
    let targetCard = null;

    // Scroll every scrollable element to the top so early-morning classes that
    // use lazy/virtual rendering are brought into the DOM before we scan.
    async function scrollScheduleToTop() {
      const scrolledCount = await page.evaluate(() => {
        let n = 0;
        document.querySelectorAll('*').forEach(el => {
          if (el.scrollTop > 0) { el.scrollTop = 0; n++; }
        });
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        return n;
      });
      console.log(`scrollScheduleToTop: reset ${scrolledCount} element(s).`);
      await page.waitForTimeout(800); // let renderer populate newly-visible rows
    }

    // Probe the DOM for any element containing the target time string, and also
    // dump all unique time-range strings visible (e.g. "7:45 a - 8:45 a").
    async function probeTimeInDom() {
      return page.evaluate((timeStr) => {
        const found = [];
        const timePattern = /\d+:\d+\s*[ap]/i;
        const allTimes = new Set();

        for (const el of document.querySelectorAll('*')) {
          const txt = el.textContent.toLowerCase();
          if (txt.includes(timeStr) && found.length < 6) {
            found.push(el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
          }
          // Collect short leaf-ish elements that look like a time range
          if (timePattern.test(el.textContent) && el.children.length <= 3 &&
              el.textContent.trim().length < 30) {
            allTimes.add(el.textContent.replace(/\s+/g, ' ').trim());
          }
        }
        return { found, allTimes: [...allTimes].slice(0, 20) };
      }, classTimeNorm || '7:45 a');
    }

    // Helper: scan a set of day-tab locators and return the first card match.
    async function scanTabs(tabs, count) {
      for (let w = 0; w < count; w++) {
        const tabText = await tabs.nth(w).textContent();
        console.log('Trying tab: ' + tabText.trim());
        await tabs.nth(w).click();
        await page.waitForTimeout(2000);
        await scrollScheduleToTop();
        const card = await findTargetCard();
        if (card) { console.log('Found class on ' + tabText.trim()); return card; }
        const probe = await probeTimeInDom();
        console.log('DOM probe "' + (classTimeNorm||'7:45 a') + '" on ' + tabText.trim() + ':', probe.found.length ? probe.found : '(absent)');
        console.log('All visible times on ' + tabText.trim() + ':', probe.allTimes.length ? probe.allTimes : '(none)');
        console.log('Class not found on ' + tabText.trim() + ', trying next tab...');
      }
      return null;
    }

    // If targetDate is set, click that specific date tab first (faster and unambiguous).
    // Fall back to scanning all matching day tabs if the exact tab isn't visible yet.
    if (targetDayNum !== null) {
      let exactTabClicked = false;
      for (let w = 0; w < dayTabCount; w++) {
        const tabText = await dayTabs.nth(w).textContent();
        const tabNum  = parseInt(tabText.replace(/\D+/g, ''), 10);
        if (tabNum === targetDayNum) {
          console.log('Clicking exact date tab: ' + tabText.trim());
          await dayTabs.nth(w).click();
          await page.waitForTimeout(2000);
          await scrollScheduleToTop();
          targetCard = await findTargetCard();
          if (targetCard) {
            console.log('Found class on exact date tab: ' + tabText.trim());
          } else {
            const probe = await probeTimeInDom();
            console.log('DOM probe "' + (classTimeNorm||'7:45 a') + '" on exact tab:', probe.found.length ? probe.found : '(absent)');
            console.log('All visible times on exact tab:', probe.allTimes.length ? probe.allTimes : '(none)');
            console.log('Class not on exact date tab — falling back to full scan.');
          }
          exactTabClicked = true;
          break;
        }
      }
      if (!exactTabClicked) {
        console.log(`Exact tab for day ${targetDayNum} not visible — falling back to full scan.`);
      }
    }

    // Fallback: scan all matching day tabs in order (also the path when targetDate is absent).
    if (!targetCard) {
      targetCard = await scanTabs(dayTabs, dayTabCount);
    }

    if (!targetCard) {
      const msg = `Could not find class at ${classTime || 'target time'} with instructor ${instructor || 'Stephanie'} on any ${dayOfWeek || dayShort} tab.`;
      console.log(msg);
      await snap();
      return { status: 'error', message: msg, screenshotPath };
    }

    // Scroll the card into view (5 s max — element may be in DOM but not yet
    // visible if the tab panel is still animating; catch and continue rather
    // than hanging the whole run for 30 s).
    try {
      await targetCard.scrollIntoViewIfNeeded({ timeout: 5000 });
    } catch (scrollErr) {
      console.log('⚠️ scrollIntoViewIfNeeded timed out:', scrollErr.message.split('\n')[0]);
    }
    await page.waitForTimeout(300);
    console.log('Card visible:', await targetCard.isVisible(), '| box:', JSON.stringify(await targetCard.boundingBox()));
    {
      const clickable = targetCard.locator("button, a, [role='button']").first();
      const hasClickable = (await clickable.count()) > 0;
      if (DEBUG_HIGHLIGHT) {
        await highlightElement(page, hasClickable ? clickable : targetCard);
        await page.waitForTimeout(400); // pause so highlight is visible in screenshot
      }
      if (DEBUG_PAUSE) {
        console.log('⏸  Pausing before click — Playwright Inspector is open.');
        console.log('👉 Hover elements, test selectors, then press Resume to continue.');
        await page.pause();
      }
      try {
        if (hasClickable) {
          await clickable.click();
        } else {
          await targetCard.click();
        }
      } catch (clickErr) {
        console.log('⚠️ Normal click failed, trying force fallback:', clickErr.message);
        await targetCard.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        if (hasClickable) {
          await clickable.click({ force: true });
        } else {
          await targetCard.click({ force: true });
        }
      }
    }
    await page.waitForTimeout(2000);

    // Step 4b: Verify the modal/detail panel matches the expected time + instructor
    // BEFORE attempting to click Register/Waitlist.  This is the safety gate that
    // prevents a fallback selection from booking the wrong class.
    // Uses page body text so it works regardless of Bubble.io's modal selector.
    {
      const modalText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      const verifyTime  = !!classTimeNorm && modalText.includes(classTimeNorm);
      const verifyInst  = modalText.includes(instructorFirstName);
      console.log('Modal verification —', JSON.stringify({ verifyTime, verifyInst, classTimeNorm, instructorFirstName }));
      if (!verifyTime || !verifyInst) {
        const reasons = [];
        if (!verifyTime) reasons.push('time');
        if (!verifyInst) reasons.push('instructor');
        const reasonTag = reasons.join('-');
        const reasonLabel = { 'time': 'Time mismatch', 'instructor': 'Instructor mismatch', 'time-instructor': 'Time + Instructor mismatch' }[reasonTag] || 'Unknown mismatch';
        console.log('❌ Modal verification failed:', reasonLabel);
        console.log('Expected:', { time: classTimeNorm, instructor: instructorFirstName });
        console.log('Modal preview:', modalText.slice(0, 300));
        await snap(`verify-${reasonTag}`);
        // Write JSON sidecar alongside the screenshot so the dashboard can show
        // contextual trace details without a database.
        if (screenshotPath) {
          try {
            const meta = {
              reason: reasonTag,
              expectedTime: classTimeNorm,
              expectedInstructor: instructorFirstName,
              classTitle: classTitle || null,
              modalPreview: modalText.slice(0, 300),
              timestamp: new Date().toISOString(),
            };
            fs.writeFileSync(screenshotPath.replace('.png', '.json'), JSON.stringify(meta, null, 2));
          } catch (e) { console.log('Meta write failed:', e.message); }
        }
        const failMsg = `Modal verification failed (${reasonTag}): expected time="${classTimeNorm}" (found:${verifyTime}) instructor="${instructorFirstName}" (found:${verifyInst})`;
        return { status: 'error', message: failMsg, screenshotPath };
      }
      console.log('✅ Modal verified — proceeding to booking.');
    }

    // Step 5: Try to register — retry every 30s for up to 10 minutes if not open yet.
    // maxAttemptsOpt can be passed in job object (e.g. 1 for web UI, 20 for cron).
    const maxAttempts = maxAttemptsOpt || 20;
    let registered = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const registerBtn = page.locator('button:has-text("Register")');
      const waitlistBtn = page.locator('button:has-text("aitlist")');
      const hasRegister = await registerBtn.count() > 0;
      const hasWaitlist = await waitlistBtn.count() > 0;

      // Log all visible buttons for debugging
      const allBtns = await page.locator('button:visible').allTextContents();
      console.log('Attempt ' + attempt + ': visible buttons: ' + JSON.stringify(allBtns));

      const hasLoginButton = allBtns.some(b => b.toLowerCase().includes('login to register'));
      if (hasLoginButton) {
        console.log('Session not authenticated — page shows "Login to Register". Failing fast.');
        await snap();
        return { status: 'error', message: 'Authentication/session failed: page shows "Login to Register"', screenshotPath };
      }

      if (hasRegister) {
        if (DRY_RUN) {
          console.log('DRY RUN: Would click Register button. Done.');
          registered = true;
          break;
        }
        await registerBtn.first().click();
        console.log('SUCCESS: Registered for Core Pilates 7:45 AM with Stephanie');
        registered = true;
        break;
      } else if (hasWaitlist) {
        if (DRY_RUN) {
          console.log('DRY RUN: Would click Waitlist button. Done.');
          registered = true;
          break;
        }
        await waitlistBtn.first().click();
        console.log('WAITLIST: Class full — joined waitlist for Core Pilates 7:45 AM');
        registered = true;
        break;
      } else {
        console.log('Attempt ' + attempt + ': No register/waitlist button found.' + (DRY_RUN ? ' (dry run — pausing 10s for inspection)' : ' Retrying in 30s...'));
        if (DRY_RUN) { await page.waitForTimeout(10000); break; }
        await page.waitForTimeout(30000);
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);

        // Re-find the correct day tab after reload, using exact-date if available.
        const dayTabsRetry    = page.locator(`text=/${dayShort} \\d+/`);
        const dayTabCountRetry = await dayTabsRetry.count();
        if (targetDayNum !== null) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            const tabText = await dayTabsRetry.nth(w).textContent();
            if (parseInt(tabText.replace(/\D+/g, ''), 10) === targetDayNum) {
              await dayTabsRetry.nth(w).click();
              await page.waitForTimeout(2000);
              await scrollScheduleToTop();
              targetCard = await findTargetCard();
              break;
            }
          }
        }
        if (!targetCard) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            await dayTabsRetry.nth(w).click();
            await page.waitForTimeout(2000);
            await scrollScheduleToTop();
            targetCard = await findTargetCard();
            if (targetCard) break;
          }
        }

        if (targetCard) {
          try {
            await targetCard.scrollIntoViewIfNeeded({ timeout: 5000 });
          } catch (scrollErr) {
            console.log('⚠️ Retry scrollIntoViewIfNeeded timed out:', scrollErr.message.split('\n')[0]);
          }
          await page.waitForTimeout(300);
          console.log('Retry card visible:', await targetCard.isVisible(), '| box:', JSON.stringify(await targetCard.boundingBox()));
          const clickableRetry = targetCard.locator("button, a, [role='button']").first();
          const hasClickableRetry = (await clickableRetry.count()) > 0;
          if (DEBUG_HIGHLIGHT) {
            await highlightElement(page, hasClickableRetry ? clickableRetry : targetCard);
            await page.waitForTimeout(400);
          }
          if (DEBUG_PAUSE) {
            console.log('⏸  Pausing before retry click — Playwright Inspector is open.');
            console.log('👉 Hover elements, test selectors, then press Resume to continue.');
            await page.pause();
          }
          try {
            if (hasClickableRetry) {
              await clickableRetry.click();
            } else {
              await targetCard.click();
            }
          } catch (retryErr) {
            console.log('⚠️ Retry click fallback:', retryErr.message);
            if (hasClickableRetry) {
              await clickableRetry.click({ force: true });
            } else {
              await targetCard.click({ force: true });
            }
          }
        }
        await page.waitForTimeout(2000);
      }
    }

    if (!registered) {
      const msg = 'Registration did not open within the retry window.';
      console.log('FAILED: ' + msg);
      await snap();
      return { status: 'error', message: msg, screenshotPath };
    }

    const successMsg = DRY_RUN
      ? `DRY RUN complete for ${classTitle}`
      : `Registered for ${classTitle} with Stephanie`;
    await snap();
    return { status: 'success', message: successMsg, screenshotPath };

  } catch (err) {
    console.error('❌ Error:', err.message);
    return { status: 'error', message: err.message, screenshotPath };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { runBookingJob };

// Allow direct invocation: node src/bot/register-pilates.js
if (require.main === module) {
  runBookingJob({ classTitle: 'Core Pilates' }).then(result => {
    console.log(result.message);
    if (result.screenshotPath) console.log('Screenshot:', result.screenshotPath);
    if (result.status !== 'success') process.exit(1);
  });
}
