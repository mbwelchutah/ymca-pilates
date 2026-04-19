'use strict';
// waitlist-position-recheck.js — Task #102
//
// Lightweight FW position re-check for jobs already in last_result === 'waitlist'.
// Joining the waitlist from a browser (manual enrollment) bypasses the bot's
// post-Reserve polling, so the cached position can be missing or stale. This
// helper opens the FW schedule, finds the class modal, reads the orange
// "#N On Waitlist" badge, and updates waitlist-position-store.
//
// READ-ONLY — never clicks Register / Reserve / Waitlist / Cancel. Worst case
// the function reports { ok:false, position:null } and the cached value is
// left untouched.
//
// Mirrors the navigation pattern from cancelRegistration() in
// register-pilates.js (auth → goto → filter → tab → card → modal) but stops
// after reading the badge.

const { createSession } = require('./daxko-session');
const { acquireLock, releaseLock, isLocked } = require('./auth-lock');
const { pingSessionHttp } = require('./session-ping');
const { checkJobConsistency } = require('../scheduler/job-consistency');
const positionStore = require('./waitlist-position-store');

const isHeadless = process.env.HEADLESS !== 'false';

const MODAL_READY = [
  'button:has-text("Register")', 'button:has-text("Reserve")',
  '[role="button"]:has-text("Register")', '[role="button"]:has-text("Reserve")',
  'button:has-text("aitlist")', '[role="button"]:has-text("aitlist")',
  'button:has-text("Cancel")', '[role="button"]:has-text("Cancel")',
].join(', ');

// Same regex shape as register-pilates.js POSITION_RE — accepts "#10 On
// Waitlist", "10 on the waitlist", etc. Captures the digits.
const POSITION_RE = /#?\s*(\d+)\s*on\s*(?:the\s*)?wait[\s-]?list/i;

const CONFIDENCE_THRESHOLD = 8;

async function _findCard(page, classTitleLower, instructorFirstName, classTimeNorm) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-wl-recheck-target]')
      .forEach(e => e.removeAttribute('data-wl-recheck-target'));
  });
  const result = await page.evaluate(({ classTitleLower, instrFirst, confidenceThreshold, classTimeNorm }) => {
    const SKIP = new Set(['OPTION','SELECT','SCRIPT','STYLE','HEAD','HTML','BODY','NOSCRIPT','SVG','PATH']);
    const norm = t => (t||'').replace(/[\s\u00A0\u2009\u202f]+/g,' ').trim();
    let timeAmRe;
    if (classTimeNorm) {
      const m = classTimeNorm.match(/^(\d+:\d+)\s*([ap])/i);
      timeAmRe = m ? new RegExp(m[1]+'\\s*'+m[2],'i') : /(?!)/;
    } else { timeAmRe = /(?!)/; }
    const titleParts = classTitleLower.split(/\s+/).map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    const titleRe = new RegExp(titleParts.join('[\\s\\u00A0]+'),'i');
    const instrRe = instrFirst ? new RegExp(instrFirst,'i') : /(?!)/;
    const rows = [];
    for (const el of document.querySelectorAll('*')) {
      if (SKIP.has(el.tagName)) continue;
      const desc = el.querySelectorAll('*').length;
      if (desc > 100 || desc < 2) continue;
      const txt = norm(el.textContent||'');
      if (!txt) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      let score = 0;
      if (titleRe.test(txt)) score += 5;
      if (timeAmRe.test(txt)) score += 5;
      if (instrFirst && instrRe.test(txt)) score += 3;
      if (score < confidenceThreshold) continue;
      rows.push({ el, score, desc, visible: r.width>=100 && r.height>=30, txt: txt.slice(0,200) });
    }
    rows.sort((a,b)=>b.score-a.score||(b.visible?1:0)-(a.visible?1:0)||a.desc-b.desc);
    if (!rows.length) return null;
    rows[0].el.setAttribute('data-wl-recheck-target','yes');
    return { score: rows[0].score, txt: rows[0].txt };
  }, { classTitleLower, instrFirst: instructorFirstName, confidenceThreshold: CONFIDENCE_THRESHOLD, classTimeNorm });
  if (!result) return null;
  return page.locator('[data-wl-recheck-target="yes"]').first();
}

async function _scrollPanel(page, amount) {
  await page.evaluate((amt) => {
    let best = null, bestH = 0;
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (s.overflowY!=='auto'&&s.overflowY!=='scroll'&&s.overflow!=='auto'&&s.overflow!=='scroll') continue;
      if (el.scrollHeight<=el.clientHeight+50) continue;
      const r = el.getBoundingClientRect();
      if (r.width<100||r.height<100) continue;
      if (r.height>bestH) { best=el; bestH=r.height; }
    }
    if (best) best.scrollTop += amt;
  }, amount);
}

async function _findCardWithScan(page, args) {
  let card = await _findCard(page, args.classTitleLower, args.instructorFirstName, args.classTimeNorm);
  if (card) return card;
  await _scrollPanel(page, -999999);
  await page.waitForTimeout(50);
  card = await _findCard(page, args.classTitleLower, args.instructorFirstName, args.classTimeNorm);
  if (card) return card;
  for (let i=0; i<40; i++) {
    await _scrollPanel(page, 120);
    await page.waitForTimeout(50);
    card = await _findCard(page, args.classTitleLower, args.instructorFirstName, args.classTimeNorm);
    if (card) return card;
  }
  return null;
}

// Given a job in last_result=='waitlist' state, opens FW, finds the class
// modal, and reads the "#N On Waitlist" badge. On success, updates the
// waitlist-position-store and returns { ok:true, position:N }. On any
// failure returns { ok:false, position:null, message }.
//
// Read-only: never clicks any Register/Reserve/Waitlist/Cancel buttons.
async function recheckWaitlistPosition(job) {
  const { id, classTitle, classTime, instructor, dayOfWeek, targetDate } = job;
  if (!classTitle) return { ok:false, position:null, message:'Job is missing classTitle' };

  const classTitleLower = classTitle.toLowerCase();
  const classTimeNorm = classTime
    ? classTime.trim().toLowerCase().replace(/^(\d+:\d+)\s*(am|pm).*/, (_, t, ap) => t + ' ' + ap[0])
    : null;
  const instructorFirstName = instructor
    ? instructor.trim().split(/\s+/)[0].toLowerCase()
    : null;

  const DAY_SHORT = {
    Sunday:'Sun', Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed',
    Thursday:'Thu', Friday:'Fri', Saturday:'Sat',
  };
  let dayShort = DAY_SHORT[dayOfWeek] || 'Wed';
  let targetDayNum = null;
  if (targetDate) {
    const d = new Date(targetDate + 'T00:00:00Z');
    dayShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    targetDayNum = d.getUTCDate();
    const wc = checkJobConsistency(job);
    if (!wc.isConsistent) {
      console.warn(
        `[wl-recheck] Job #${id}: stored day_of_week "${dayOfWeek}" does not ` +
        `match target_date ${targetDate} (${wc.computedWeekday}) — using "${dayShort} ${targetDayNum}".`
      );
    }
  }

  let browser = null;
  let _authLockAcquired = false;

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    let _tier2Trusted = false;
    try {
      const ping = await pingSessionHttp();
      _tier2Trusted = ping.trusted === true;
    } catch { /* fall through to full auth */ }

    if (!_tier2Trusted) {
      if (isLocked()) return { ok:false, position:null, message:'Auth lock held — skipping recheck' };
      _authLockAcquired = acquireLock('waitlist-recheck','signing_in');
    }

    let _session;
    try {
      _session = await createSession({ headless: isHeadless });
    } catch (loginErr) {
      return { ok:false, position:null, message: loginErr.message || 'Login failed' };
    }
    if (_authLockAcquired) { releaseLock(); _authLockAcquired = false; }

    browser = _session.browser;
    const page = _session.page;

    // ── Navigate ────────────────────────────────────────────────────────────
    console.log(`[wl-recheck] Job #${id} — navigating to schedule…`);
    await page.goto('https://my.familyworks.app/schedulesembed/eugeneymca?search=yes', { timeout:60000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const loginPrompt = await page.locator('text=/login to register/i').count();
    if (loginPrompt > 0) {
      return { ok:false, position:null, message:'Session not established — schedule page requires login' };
    }

    await page.waitForFunction(() => {
      const sels = document.querySelectorAll('select');
      for (const s of sels) if (s.options.length > 1) return true;
      return false;
    }, { timeout:15000 }).catch(()=>{});

    // ── Yoga/Pilates filter ────────────────────────────────────────────────
    const selects = page.locator('select');
    const selCount = await selects.count();
    for (let i=0; i<selCount; i++) {
      const opts = await selects.nth(i).locator('option').allTextContents();
      if (opts.some(o => /yoga.*pilates|pilates.*yoga/i.test(o))) {
        await selects.nth(i).selectOption({ label: 'Yoga/Pilates' });
        await page.waitForSelector(
          '[data-repeater-item], .bbl-rg-item, .schedule-row, [class*="rg-item"]',
          { timeout:600 },
        ).catch(()=>{});
        await page.waitForTimeout(200);
        break;
      }
    }
    await page.waitForTimeout(150);

    // ── Day tab + card ─────────────────────────────────────────────────────
    const dayTabs = page.locator(`text=/${dayShort} \\d+/`);
    const tabCount = await dayTabs.count();
    let card = null;
    const findArgs = { classTitleLower, instructorFirstName, classTimeNorm };
    if (targetDayNum !== null) {
      for (let w=0; w<tabCount; w++) {
        const tabTxt = await dayTabs.nth(w).textContent();
        if (parseInt(tabTxt.replace(/\D+/g,''),10) === targetDayNum) {
          await dayTabs.nth(w).click();
          card = await _findCardWithScan(page, findArgs);
          break;
        }
      }
    }
    if (!card) {
      for (let w=0; w<tabCount; w++) {
        await dayTabs.nth(w).click();
        card = await _findCardWithScan(page, findArgs);
        if (card) break;
      }
    }

    if (!card) {
      return { ok:false, position:null, message:`Class card not found on schedule for "${classTitle}"` };
    }

    // ── Open modal ─────────────────────────────────────────────────────────
    try { await card.scrollIntoViewIfNeeded({ timeout:5000 }); } catch {}
    await page.waitForTimeout(100);
    const clickable = card.locator("button, [role='button'], a").first();
    const clickTarget = (await clickable.count()) > 0 ? clickable : card;
    try {
      await clickTarget.scrollIntoViewIfNeeded({ timeout:3000 }).catch(()=>{});
      await clickTarget.click({ timeout:5000 });
    } catch {
      await card.click({ force:true });
    }
    await page.waitForSelector(MODAL_READY, { timeout:3000 }).catch(()=>null);
    await page.waitForTimeout(200);

    // FamilyWorks shows "View Reservation" / "View Waitlist" in the class
    // modal when you're already enrolled — clicking through opens the
    // reservation popup that actually carries the "#N On Waitlist" badge.
    const viewSel = 'button:has-text("View Reservation"), [role="button"]:has-text("View Reservation"), button:has-text("View Waitlist"), [role="button"]:has-text("View Waitlist")';
    const viewBtns = page.locator(viewSel);
    if ((await viewBtns.count()) > 0) {
      await viewBtns.first().click({ timeout:5000 }).catch(()=>{});
      await page.waitForTimeout(500);
    }

    // ── Read the "#N On Waitlist" badge from a scoped dialog container ─────
    // Mirrors register-pilates.js _pollWaitlistConfirmedState — restrict the
    // search to visible dialog/popup/overlay containers so unrelated copy
    // ("3 on waitlist" sidebar text, other class rows, etc.) cannot be
    // misattributed as this user's position.
    const position = await page.evaluate(({ posReSrc, posReFlags }) => {
      const norm = t => (t||'').replace(/\s+/g,' ').trim();
      const isVisible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      };
      const positionRe = new RegExp(posReSrc, posReFlags);
      const candidates = [...document.querySelectorAll(
        '[role="dialog"], .modal, [class*="popup" i], [class*="overlay" i]',
      )];
      for (const c of candidates) {
        if (!isVisible(c)) continue;
        const m = norm(c.textContent || '').match(positionRe);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n)) return n;
        }
      }
      return null;
    }, { posReSrc: POSITION_RE.source, posReFlags: POSITION_RE.flags }).catch(() => null);

    if (position != null) {
      positionStore.set(id, position);
      // Task #104 — positionStore.set only writes SQLite. Replit rebuilds
      // the container from git on every publish and re-seeds SQLite from
      // PostgreSQL, so without an explicit PG sync the captured position
      // would be lost on the next fresh-container restart. Awaited
      // best-effort (sync errors are logged but swallowed) before we
      // report success to the caller so PG durability is attempted first.
      try {
        const { syncJobsToPgAsync } = require('../db/pg-sync');
        await syncJobsToPgAsync().catch(e =>
          console.warn('[pg-sync] waitlist-position recheck await failed:', e.message));
      } catch (_) {}
      console.log(`[wl-recheck] Job #${id} — position #${position} captured & stored.`);
      return { ok:true, position, message:`Captured waitlist position #${position}` };
    }
    return { ok:false, position:null, message:'Waitlist badge not visible in modal' };
  } catch (err) {
    return { ok:false, position:null, message: err.message || 'Unexpected error during recheck' };
  } finally {
    if (browser) await browser.close().catch(()=>{});
    if (_authLockAcquired) releaseLock();
  }
}

module.exports = { recheckWaitlistPosition };
