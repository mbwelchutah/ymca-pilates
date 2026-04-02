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
    // Explicit viewport so Bubble.io renders the desktop filter-pill layout,
    // not a collapsed mobile layout that behaves differently.
    await page.setViewportSize({ width: 1280, height: 800 });

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
      console.log(`  Clicked pill — checking open state...`);

      // Step 2a: Check aria-expanded on the pill or any child (Method A from guide).
      const ariaOpen = await trigger.evaluate(el => {
        if (el.getAttribute('aria-expanded') === 'true') return true;
        for (const child of el.querySelectorAll('[aria-expanded]'))
          if (child.getAttribute('aria-expanded') === 'true') return true;
        return false;
      }).catch(() => false);
      if (ariaOpen) {
        console.log(`  Dropdown open confirmed via aria-expanded.`);
      } else {
        console.log(`  No aria-expanded=true found — waiting for visible option as open signal.`);
      }

      // Take a debug snapshot immediately after the click so we can see what rendered.
      await snap(`filter-${selectIndex}-after-click`);

      // Step 3: Poll until a visible (rendered, non-option) element with targetValue appears.
      // This is the most reliable open-state signal (Method B from guide).
      // offsetWidth/offsetHeight are 0 for display:none elements (hidden <option>).
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
        // Snapshot the failed state so we can diagnose visually.
        await snap(`filter-${selectIndex}-timeout`);
        // Dump the top visible text elements to narrow down what IS on screen.
        const visibleTexts = await page.evaluate(() =>
          [...document.querySelectorAll('*')]
            .filter(e => e.tagName !== 'OPTION' && e.tagName !== 'SELECT' &&
                         e.offsetWidth > 0 && e.offsetHeight > 0 &&
                         e.children.length === 0 && e.textContent.trim().length > 0)
            .slice(0, 30)
            .map(e => `[${e.tagName}] "${e.textContent.trim()}"`)
        ).catch(() => []);
        console.log(`⚠️ Timed out waiting for visible "${targetValue}". Visible leaves:\n  ${visibleTexts.join('\n  ')}`);
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

    // ---------------------------------------------------------------------------
    // Step 3: Find the target class card.
    //
    // Strategy:
    //  A) Search the ENTIRE DOM (including off-screen elements) for any element
    //     that contains the target time ("7:45") + AM marker + optionally the
    //     class title and instructor first name.
    //     Non-breaking spaces (\u00A0) are normalized before matching.
    //  B) Score each matching element:
    //       title "core pilates"  → +40 pts
    //       time  "7:45" + AM     → +40 pts  ("7:45 a", "7:45 AM", "7:45am" all match)
    //       instructor first name → +20 pts  ("stephanie" matches "Stephanie S.")
    //  C) Pick the highest-scoring, most-specific (fewest descendants) element.
    //  D) If no element is found immediately, slowly scroll the LARGEST VISIBLE
    //     scrollable panel (the schedule list) and retry up to 60 steps.
    //  E) Scroll the winning element into view, then click its visible interactive
    //     child (button / a / role=button / tabindex) — NOT an invisible wrapper.
    // ---------------------------------------------------------------------------

    async function findTargetCard() {
      // Clear any previous marker
      await page.evaluate(() =>
        document.querySelectorAll('[data-target-class]')
          .forEach(el => el.removeAttribute('data-target-class'))
      );

      const result = await page.evaluate(({ classTitleLower, instructorFirstName }) => {
        const SKIP_TAGS = new Set(['OPTION','SELECT','SCRIPT','STYLE','HEAD','HTML','BODY','NOSCRIPT']);

        // Normalize: collapse all whitespace including \u00A0 (non-breaking space used
        // by Bubble.io) so the regex doesn't fail on invisible whitespace variants.
        function norm(txt) {
          return (txt || '').replace(/[\s\u00A0]+/g, ' ').trim();
        }

        const allRows = [];
        const timeAmRe = /7:45[\s\u00A0]{0,4}a(?:m\b|\s|\u00A0|[-\u2013\u2014])/i;

        for (const el of document.querySelectorAll('*')) {
          if (SKIP_TAGS.has(el.tagName)) continue;

          // Defense-in-depth: skip massive wrappers (real card rows have < 500 descendants).
          // Check this cheaply BEFORE reading textContent on huge trees.
          if (el.querySelectorAll('*').length > 500) continue;

          const raw  = el.textContent || '';
          const txt  = norm(raw);
          const txtL = txt.toLowerCase();

          // Fast pre-filter: must contain the AM time string (not just "7:45" which
          // could be a PM class that happens to share the hour).
          if (!timeAmRe.test(raw) && !timeAmRe.test(txt)) continue;

          let score = 0;
          const reasons = [];

          // --- Time signal (+40) --- MANDATORY: element must contain the AM time.
          // Accept: "7:45 a", "7:45a", "7:45 AM", "7:45am", "7:45\u00A0a"
          // Reject: "7:45 p", "7:45 PM", "7:45pm"
          score += 40;
          reasons.push('time+40');

          // --- Title signal (+40) ---
          if (classTitleLower && txtL.includes(classTitleLower)) {
            score += 40;
            reasons.push('title+40');
          }

          // --- Instructor first-name signal (+20) ---
          if (instructorFirstName && txtL.includes(instructorFirstName.toLowerCase())) {
            score += 20;
            reasons.push('instr+20');
          }

          // Require at least one more signal beyond time (title OR instructor).
          // A lone time match (score=40) is too ambiguous — lots of 7:45 AM classes exist.
          if (score < 60) continue;

          const r = el.getBoundingClientRect();
          allRows.push({
            el,
            score,
            reasons,
            desc: el.querySelectorAll('*').length,
            visible: r.width > 0 && r.height > 0,
            txt: txt.slice(0, 200),
          });
        }

        // Sort: highest score first; tie-break on fewest descendants (most specific row).
        allRows.sort((a, b) => b.score - a.score || a.desc - b.desc);

        if (allRows.length === 0) return { matched: null, allResults: [] };

        // Mark the best match so Playwright can locate it.
        allRows[0].el.setAttribute('data-target-class', 'yes');

        return {
          matched: allRows[0].txt,
          score:   allRows[0].score,
          reasons: allRows[0].reasons,
          desc:    allRows[0].desc,
          visible: allRows[0].visible,
          allResults: allRows.map(r => ({
            score: r.score, reasons: r.reasons, desc: r.desc, visible: r.visible,
            txt: r.txt.slice(0, 120),
          })).slice(0, 10),
        };
      }, { classTitleLower, instructorFirstName });

      // Log every scored candidate before deciding.
      if (result.allResults && result.allResults.length > 0) {
        console.log(`  Scored candidates (${result.allResults.length} with time+40 + score≥60):`);
        result.allResults.forEach((r, i) =>
          console.log(`    [${i}] score=${r.score} desc=${r.desc} visible=${r.visible} (${r.reasons.join(',')}) "${r.txt}"`)
        );
      } else {
        console.log('  No candidates with time+title/instr signal (time+40 required, score≥60).');
      }

      if (!result.matched) return null;

      console.log(`✅ Best card (score=${result.score} desc=${result.desc} visible=${result.visible}): "${result.matched}"`);
      return page.locator('[data-target-class="yes"]').first();
    }

    // Scroll the LARGEST VISIBLE scrollable panel (the schedule list) by `amount` px.
    // Uses mouse.wheel() to fire native scroll events that Bubble.io's virtual
    // RepeatingGroup listens to for re-rendering.  Direct scrollTop writes are silent
    // and don't trigger re-renders — so we wheel-scroll instead.
    async function scrollSchedulePanel(amount) {
      if (amount < -10000) {
        // RESET: use both direct scrollTop (fast) and a large upward wheel (fires events).
        await page.evaluate(() => {
          let best = null, bestH = 0;
          for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if (s.overflowY !== 'auto' && s.overflowY !== 'scroll' &&
                s.overflow  !== 'auto' && s.overflow  !== 'scroll') continue;
            if (el.scrollHeight <= el.clientHeight + 50) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 100) continue;
            if (r.height > bestH) { best = el; bestH = r.height; }
          }
          if (best) { best.scrollTop = 0; best.dispatchEvent(new Event('scroll', { bubbles: true })); }
        });
        return;
      }

      // INCREMENTAL: use page.mouse.wheel() so Bubble.io fires scroll/virtual-scroll events.
      // First, move mouse to centre of the schedule panel to make sure the wheel targets it.
      const center = await page.evaluate(() => {
        let best = null, bestH = 0;
        for (const el of document.querySelectorAll('*')) {
          const s = getComputedStyle(el);
          if (s.overflowY !== 'auto' && s.overflowY !== 'scroll' &&
              s.overflow  !== 'auto' && s.overflow  !== 'scroll') continue;
          if (el.scrollHeight <= el.clientHeight + 50) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 100) continue;
          if (r.height > bestH) { best = el; bestH = r.height; }
        }
        if (!best) return null;
        const r = best.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (center) {
        await page.mouse.move(center.x, center.y);
        await page.mouse.wheel(0, amount);
      } else {
        // Fallback: wheel at the middle of the viewport.
        const vp = page.viewportSize();
        await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
        await page.mouse.wheel(0, amount);
      }
    }

    // After a tab click: immediate DOM search → slow-scroll retry if not found.
    async function findCardOnTab(tabLabel) {
      await page.waitForTimeout(2000); // let the tab panel settle

      // Attempt 1: find in DOM without any scrolling.
      let card = await findTargetCard();
      if (card) return card;

      console.log(`  Not found immediately — resetting panel and scrolling to find card on ${tabLabel}...`);

      // Diagnostic: snapshot + dump visible time strings so we know what's rendered.
      await snap(`scroll-top-${tabLabel.replace(/\s+/g, '-')}`);
      const visTimeCls = await page.evaluate(() => {
        const timeRe = /\d{1,2}:\d{2}/;
        return [...document.querySelectorAll('*')]
          .filter(e => e.children.length === 0 && e.offsetWidth > 0 && e.offsetHeight > 0
                    && timeRe.test(e.textContent))
          .slice(0, 20)
          .map(e => e.textContent.trim().slice(0, 60));
      }).catch(() => []);
      console.log(`  Visible times at top: ${JSON.stringify(visTimeCls)}`);

      // Diagnostic: find what element scrollSchedulePanel would use.
      const scrollInfo = await page.evaluate(() => {
        let best = null, bestH = 0;
        for (const el of document.querySelectorAll('*')) {
          const s = getComputedStyle(el);
          if (s.overflowY !== 'auto' && s.overflowY !== 'scroll' &&
              s.overflow  !== 'auto' && s.overflow  !== 'scroll') continue;
          if (el.scrollHeight <= el.clientHeight + 50) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 100) continue;
          if (r.height > bestH) { best = el; bestH = r.height; }
        }
        if (!best) return { found: false, scrollTop: null, scrollHeight: null, clientHeight: null };
        return { found: true, tag: best.tagName, cls: best.className.slice(0, 80),
                 scrollTop: best.scrollTop, scrollHeight: best.scrollHeight,
                 clientHeight: best.clientHeight, h: Math.round(best.getBoundingClientRect().height) };
      }).catch(() => ({ found: false }));
      console.log(`  Scroll container: ${JSON.stringify(scrollInfo)}`);

      // Reset the schedule panel to its top.
      await scrollSchedulePanel(-999999);
      await page.waitForTimeout(400);

      // Slow downward sweep: 150 px steps, up to 80 steps (12 000 px total).
      // 400ms wait gives Bubble.io's virtual scroll time to re-render after each wheel event.
      const STEP_PX   = 150;
      const MAX_STEPS = 80;
      for (let step = 0; step < MAX_STEPS; step++) {
        await scrollSchedulePanel(STEP_PX);
        await page.waitForTimeout(400);
        card = await findTargetCard();
        if (card) {
          console.log(`  Found card after ${step + 1} scroll step(s).`);
          return card;
        }
        // Mid-scroll diagnostic at step 20: dump visible times to trace scroll progress
        if (step === 19) {
          const midTimes = await page.evaluate(() => {
            const timeRe = /\d{1,2}:\d{2}/;
            return [...document.querySelectorAll('*')]
              .filter(e => e.children.length === 0 && e.offsetWidth > 0 && e.offsetHeight > 0
                        && timeRe.test(e.textContent))
              .slice(0, 15)
              .map(e => e.textContent.trim().slice(0, 60));
          }).catch(() => []);
          await snap(`scroll-mid-${tabLabel.replace(/\s+/g, '-')}`);
          console.log(`  [step 20] Visible times mid-scroll: ${JSON.stringify(midTimes)}`);
        }
      }

      console.log(`  Reached scroll limit on ${tabLabel} without finding card.`);
      return null;
    }

    // Step 3: Find the target day tab then find the class card within it.
    const dayTabs = page.locator(`text=/${dayShort} \\d+/`);
    const dayTabCount = await dayTabs.count();
    console.log(`Searching ${dayTabCount} "${dayShort}" tab(s) on the schedule page.`);
    let targetCard = null;

    // Try exact date tab first, then fall back to scanning all matching day tabs.
    if (targetDayNum !== null) {
      let exactTabClicked = false;
      for (let w = 0; w < dayTabCount; w++) {
        const tabText = await dayTabs.nth(w).textContent();
        const tabNum  = parseInt(tabText.replace(/\D+/g, ''), 10);
        if (tabNum === targetDayNum) {
          console.log('Clicking exact date tab: ' + tabText.trim());
          await dayTabs.nth(w).click();
          targetCard = await findCardOnTab(tabText.trim());
          if (targetCard) console.log('Found class on exact date tab: ' + tabText.trim());
          else            console.log('Class not on exact date tab — falling back to full scan.');
          exactTabClicked = true;
          break;
        }
      }
      if (!exactTabClicked) {
        console.log(`Exact tab for day ${targetDayNum} not visible — falling back to full scan.`);
      }
    }

    // Fallback: scan all matching day tabs in order.
    if (!targetCard) {
      for (let w = 0; w < dayTabCount; w++) {
        const tabText = await dayTabs.nth(w).textContent();
        console.log('Trying tab: ' + tabText.trim());
        await dayTabs.nth(w).click();
        targetCard = await findCardOnTab(tabText.trim());
        if (targetCard) { console.log('Found class on ' + tabText.trim()); break; }
        console.log('Class not found on ' + tabText.trim() + ', trying next tab...');
      }
    }

    if (!targetCard) {
      const msg = `Could not find visible row matching Core Pilates / 7:45 / Stephanie on ${dayShort} ${targetDayNum || '(any)'}.`;
      console.log(msg);
      await snap();
      return { status: 'error', message: msg, screenshotPath };
    }

    // Scroll the card into view, then find the visible interactive child to click.
    // The schedule row has: title (not clickable) + time/instructor row (clickable chevron).
    try {
      await targetCard.scrollIntoViewIfNeeded({ timeout: 5000 });
    } catch (scrollErr) {
      console.log('⚠️ scrollIntoViewIfNeeded timed out:', scrollErr.message.split('\n')[0]);
    }
    await page.waitForTimeout(300);
    console.log('Card visible:', await targetCard.isVisible(), '| box:', JSON.stringify(await targetCard.boundingBox()));
    {
      // Prefer explicit interactive elements; chevrons in Bubble.io often have role=button
      // or tabindex but are not <button> or <a> tags.
      const clickable = targetCard.locator("button, a, [role='button'], [tabindex='0']").first();
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
        const dayTabsRetry     = page.locator(`text=/${dayShort} \\d+/`);
        const dayTabCountRetry = await dayTabsRetry.count();
        if (targetDayNum !== null) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            const tabText = await dayTabsRetry.nth(w).textContent();
            if (parseInt(tabText.replace(/\D+/g, ''), 10) === targetDayNum) {
              await dayTabsRetry.nth(w).click();
              targetCard = await findCardOnTab(tabText.trim());
              break;
            }
          }
        }
        if (!targetCard) {
          for (let w = 0; w < dayTabCountRetry; w++) {
            const tabText = await dayTabsRetry.nth(w).textContent();
            await dayTabsRetry.nth(w).click();
            targetCard = await findCardOnTab(tabText.trim());
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
          const clickableRetry = targetCard.locator("button, a, [role='button'], [tabindex='0']").first();
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
