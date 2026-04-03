// Schedule scraper — navigates to the YMCA Daxko/Bubble.io schedule page,
// iterates each day tab, and extracts all visible class cards.
// No filters are applied so the full week schedule is captured.
const { createSession } = require('./daxko-session');

const SCHEDULE_URL = 'https://my.familyworks.app/schedulesembed/eugeneymca?search=yes';

const DAY_SHORT_TO_FULL = {
  Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
  Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
};

/**
 * Scrape the full YMCA class schedule.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless=true]
 * @returns {Promise<Array<{class_title: string, day_of_week: string, class_time: string, instructor: string|null}>>}
 */
async function scrapeSchedule(opts = {}) {
  let session;
  try {
    console.log('[scraper] Starting session...');
    session = await createSession({ headless: opts.headless !== false });
    const { page, snap } = session;

    // Navigate to schedule page (no filters)
    console.log('[scraper] Navigating to schedule...');
    await page.goto(SCHEDULE_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4000);
    console.log('[scraper] Schedule page loaded. URL:', page.url());

    // Auth check: if the schedule page is still asking to log in, session failed
    const loginPrompt = await page.locator('text=/login to register/i').count();
    if (loginPrompt > 0) {
      throw new Error('Session not established — schedule page requires login');
    }

    await snap('scrape-schedule-loaded');

    // Find all day tabs: labels like "Mon 01", "Tue 02", etc.
    const dayTabLocator = page.locator('text=/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \\d+/');
    const dayTabCount = await dayTabLocator.count();
    console.log(`[scraper] Found ${dayTabCount} day tab(s)`);

    if (dayTabCount === 0) {
      console.log('[scraper] No day tabs found — returning empty result.');
      return [];
    }

    const allClasses = [];
    const seen = new Set(); // deduplicate across day tabs

    for (let i = 0; i < dayTabCount; i++) {
      let tabText;
      try {
        tabText = await dayTabLocator.nth(i).textContent();
      } catch {
        continue;
      }
      const tabMatch = tabText && tabText.trim().match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d+)/);
      if (!tabMatch) continue;

      const dayShort = tabMatch[1];
      const dayFull  = DAY_SHORT_TO_FULL[dayShort] || dayShort;

      console.log(`[scraper] Clicking day tab: "${tabText.trim()}" → ${dayFull}`);
      try {
        await dayTabLocator.nth(i).click();
      } catch (e) {
        console.log(`[scraper] Could not click tab "${tabText.trim()}": ${e.message}`);
        continue;
      }
      await page.waitForTimeout(2500);

      // Scroll schedule panel back to top before extracting
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        const panels = all.filter(el => {
          const r = el.getBoundingClientRect();
          return r.height > 200 && r.width > 150 && el.scrollHeight > el.clientHeight + 30;
        });
        if (panels.length) panels[panels.length - 1].scrollTop = 0;
      });
      await page.waitForTimeout(400);

      const dayClasses = await extractCardsFromPage(page, dayFull);
      console.log(`[scraper]   → ${dayClasses.length} class(es) extracted for ${dayFull}`);

      for (const cls of dayClasses) {
        const key = `${cls.day_of_week}|${cls.class_title}|${cls.class_time}`;
        if (!seen.has(key)) {
          seen.add(key);
          allClasses.push(cls);
        }
      }
    }

    console.log(`[scraper] Total unique classes scraped: ${allClasses.length}`);
    return allClasses;

  } catch (err) {
    console.error('[scraper] Error:', err.message);
    throw err;
  } finally {
    if (session) {
      try { await session.close(); } catch (_) {}
    }
  }
}

/**
 * Extract class cards from the currently visible schedule panel.
 * Runs inside page.evaluate so everything here is plain DOM code.
 *
 * @param {import('playwright').Page} page
 * @param {string} dayFull  e.g. "Wednesday"
 * @returns {Promise<Array<{class_title,day_of_week,class_time,instructor}>>}
 */
async function extractCardsFromPage(page, dayFull) {
  return page.evaluate((day) => {
    const SKIP_TAGS = new Set(['OPTION','SELECT','SCRIPT','STYLE','HEAD','HTML','BODY','NOSCRIPT','SVG','PATH']);
    const TIME_RE   = /\d+:\d+\s*[ap]/i;
    const SKIP_LINE = /^(register|waitlist|full|closed|cancel|book|sign up|join|\d+\s*(class|min|hour)|\u2014|–|-{2,})/i;
    const NAME_RE   = /^[A-Z][a-z]+(?:\s+[A-Z][a-z.]+)+$/; // "First Last" or "First L."

    function norm(txt) {
      return (txt || '').replace(/[\s\u00A0\u2009\u202f]+/g, ' ').trim();
    }

    const results = [];

    // Collect candidate card elements: visible, 2–80 descendants, ≥100×40 px, contains a time
    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const desc = el.querySelectorAll('*').length;
      if (desc < 2 || desc > 80) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 40) continue;
      const txt = norm(el.textContent || '');
      if (!txt || txt.length < 8) continue;
      if (!TIME_RE.test(txt)) continue;
      candidates.push({ el, desc, txt });
    }

    // Sort by fewest descendants (most specific card element first)
    candidates.sort((a, b) => a.desc - b.desc);

    // Deduplicate: skip any element that is an ancestor of an already-selected element
    const included = [];
    for (const c of candidates) {
      if (included.some(inc => c.el.contains(inc.el))) continue;
      included.push(c);
    }

    for (const { txt } of included) {
      // Extract time — first "H:MM a/p" pattern, normalise to "H:MM AM/PM"
      const timeMatch = txt.match(/(\d+:\d+)\s*([ap])(?:m)?/i);
      if (!timeMatch) continue;
      const class_time = `${timeMatch[1]} ${timeMatch[2].toUpperCase()}M`;

      // Split the card text into meaningful lines (split on 2+ spaces / newlines)
      const lines = txt
        .split(/\s{2,}|\n/)
        .map(l => norm(l))
        .filter(l => l.length > 2 && !SKIP_LINE.test(l) && !/^\d+$/.test(l));

      // Title: first line that doesn't look like a time or plain number
      let class_title = null;
      for (const line of lines) {
        if (!TIME_RE.test(line)) {
          class_title = line;
          break;
        }
      }
      if (!class_title || class_title.length < 3) continue;

      // Instructor: a line after the title that looks like "First Last"
      let instructor = null;
      const titleIdx = lines.indexOf(class_title);
      for (let j = titleIdx + 1; j < lines.length; j++) {
        const line = lines[j];
        if (!TIME_RE.test(line) && NAME_RE.test(line)) {
          instructor = line;
          break;
        }
      }

      results.push({
        class_title: class_title.trim(),
        day_of_week: day,
        class_time,
        instructor: instructor || null,
      });
    }

    return results;
  }, dayFull);
}

module.exports = { scrapeSchedule };
