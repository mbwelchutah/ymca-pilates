// Web server entry point — started by Replit (npm start).
// Serves a jobs dashboard at / and booking API routes.
const http = require('http');
const { URL } = require('url');
const { getJobById, getAllJobs, createJob, updateJob, deleteJob, setJobActive, setLastRun, clearLastRun } = require('../db/jobs');
const { openDb } = require('../db/init');
const { runBookingJob } = require('../bot/register-pilates');
const { scrapeSchedule } = require('../bot/scrape-schedule');
const { getDryRun, setDryRun } = require('../bot/dry-run-state');
const { getPhase }           = require('../scheduler/booking-window');
const { setSchedulerPaused, isSchedulerPaused } = require('../scheduler/scheduler-state');
const { runTick }            = require('../scheduler/tick');
// Stage 10G — Booking bridge: lets burst-to-booking handoff update jobState.
const { setBridgeCallbacks } = require('../scheduler/booking-bridge');
const {
  checkAutoPreflights,
  loadSettings:      loadAutoPreflightSettings,
  saveSettings:      saveAutoPreflightSettings,
  loadLog:           loadAutoPreflightLog,
  getNextTrigger:    getNextAutoTrigger,
} = require('../scheduler/auto-preflight');
const {
  checkSessionKeepalive,
  saveSettings:      saveKeepaliveSettings,
  getKeepaliveConfig,
} = require('../scheduler/session-keepalive');
const {
  runPreflightLoop,
  loadLoopState: loadPreflightLoopState,
} = require('../scheduler/preflight-loop');
const { acquireLock: acquireAuthLock, releaseLock: releaseAuthLock, isLocked: isAuthLocked, lockOwner: authLockOwner } = require('../bot/auth-lock');
const replayStore = require('../bot/replay-store');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// ---------------------------------------------------------------------------
// Static file serving — used in production when the React app is pre-built.
// In development, Vite runs its own server (port 5001 for this backend).
// ---------------------------------------------------------------------------
const fsStatic   = require('fs');
const pathStatic = require('path');
const DIST_DIR   = pathStatic.join(__dirname, '../../dist');
const DIST_INDEX = pathStatic.join(DIST_DIR, 'index.html');
const SERVE_REACT = fsStatic.existsSync(DIST_INDEX);

const STATIC_MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript',
  '.mjs':   'application/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
};

function serveStatic(res, filePath) {
  if (!fsStatic.existsSync(filePath)) return false;
  const ext = pathStatic.extname(filePath).toLowerCase();
  const mime  = STATIC_MIME[ext] || 'application/octet-stream';
  const cache = ext === '.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache });
  fsStatic.createReadStream(filePath).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// PWA helpers — generate solid-colour PNG icons without external packages.
// ---------------------------------------------------------------------------
function makeSolidPng(width, height, r, g, b) {
  const zlib = require('zlib');
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const tb = Buffer.from(type, 'ascii');
    const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([lb, tb, data, cb]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3);
  row[0] = 0; // filter: None
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Cache generated PNGs so they're only built once per process lifetime.
const _pngCache = {};
function getCachedPng(size) {
  if (!_pngCache[size]) _pngCache[size] = makeSolidPng(size, size, 28, 35, 64); // #1c2340
  return _pngCache[size];
}

const MANIFEST_JSON = JSON.stringify({
  name: 'YMCA Booker',
  short_name: 'YMCA',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
});

// ---------------------------------------------------------------------------
// HTML builder — generates the full page with jobs injected server-side.
// ---------------------------------------------------------------------------
function buildHtml(jobs, error, editError) {
  const dryRunEnabled = getDryRun();
  const hasJobs = jobs && jobs.length > 0;
  const first   = hasJobs ? jobs[0] : null;
  const firstLabel = first
    ? `Job #${first.id} \u2014 ${first.class_title} \u00b7 ${first.day_of_week || ''} \u00b7 ${first.class_time || ''} \u00b7 ${first.instructor || ''}`
    : null;

  // Compute booking phase + booking-open timestamp for a job.
  // Returns { phase, bookingOpenMs } where bookingOpenMs is epoch ms (or null).
  function jobInfo(j) {
    try {
      const r = getPhase(j);
      return { phase: r.phase, bookingOpenMs: r.bookingOpen ? r.bookingOpen.getTime() : null };
    } catch(e) {
      return { phase: 'unknown', bookingOpenMs: null };
    }
  }
  // Thin wrapper kept for the two callers that only need phase.
  function jobPhase(j) { return jobInfo(j).phase; }

  // Mirror of the scheduler's already-booked logic for display purposes.
  function isBookedSS(j) {
    if (!j || !j.last_success_at) return false;
    if (j.target_date) return j.last_success_at.startsWith(j.target_date);
    // Week-based fallback: Monday 00:00 UTC as week start.
    const successDate  = new Date(j.last_success_at);
    const now          = new Date();
    const daysSinceMon = (now.getUTCDay() + 6) % 7;
    const weekStart    = new Date(now);
    weekStart.setUTCHours(0, 0, 0, 0);
    weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon);
    return successDate >= weekStart;
  }

  const firstIsBooked = isBookedSS(first);

  const PHASE_LABEL = {
    too_early: 'Too Early',
    warmup:    'Warmup',
    sniper:    'Sniper',
    late:      'Open',
    unknown:   'Unknown',
  };

  // Format an ISO timestamp to a short local time string, or "Never".
  function fmtRunAt(iso) {
    if (!iso) return 'Never';
    try {
      return new Date(iso).toLocaleString('en-US', {
        timeZone:  'America/Los_Angeles',
        month:     'short',
        day:       'numeric',
        hour:      'numeric',
        minute:    '2-digit',
        hour12:    true,
      });
    } catch (e) { return iso; }
  }

  // Render a last_result value as a colored badge, or an em-dash for null.
  function resultBadge(r) {
    if (!r) return '<span class="badge badge-result-none">\u2014</span>';
    return '<span class="badge badge-result-' + esc(r) + '">' + esc(r) + '</span>';
  }

  const jobRowsHtml = hasJobs
    ? jobs.map(j => {
        const { phase, bookingOpenMs } = jobInfo(j);
        const phaseBadge    = '<span class="badge badge-phase-' + phase + '">' + (PHASE_LABEL[phase] || phase) + '</span>';
        const jobBooked     = isBookedSS(j);
        const bookedBadge   = jobBooked
          ? '<br><span class="badge-booked">&#10003;&nbsp;Booked</span>'
          : '';
        const lastRunCell   = fmtRunAt(j.last_run_at);
        const lastResBadge  = resultBadge(j.last_result);
        return `
        <tr class="job-row"
            data-id="${j.id}"
            data-title="${esc(j.class_title)}"
            data-day="${esc(j.day_of_week || '')}"
            data-time="${esc(j.class_time || '')}"
            data-instructor="${esc(j.instructor || '')}"
            data-phase="${esc(phase)}"
            data-last-run-at="${esc(j.last_run_at || '')}"
            data-last-result="${esc(j.last_result || '')}"
            data-target-date="${esc(j.target_date || '')}"
            data-is-active="${j.is_active ? '1' : '0'}"
            data-last-success-at="${esc(j.last_success_at || '')}"
            data-last-error-msg="${esc(j.last_error_message || '')}"
            data-booking-open="${bookingOpenMs || ''}"
            onclick="selectJob(this, true)">
          <td class="job-id">#${j.id}</td>
          <td><span class="dot ${j.is_active ? 'dot-on' : 'dot-off'}" title="${j.is_active ? 'Active' : 'Inactive'}"></span><strong>${esc(j.class_title)}</strong>${['error','not_found','found_not_open_yet'].includes(j.last_result) && j.last_error_message ? ` <span class="row-warn" title="${esc(j.last_error_message)}">&#9888;</span>` : ''}</td>
          <td>${esc(j.day_of_week  || '\u2014')}</td>
          <td>${esc(j.class_time   || '\u2014')}</td>
          <td>${esc(j.target_date  || '\u2014')}</td>
          <td>${esc(j.instructor   || '\u2014')}</td>
          <td>${phaseBadge}${bookedBadge}</td>
          <td class="col-last-run">${lastRunCell}</td>
          <td>${lastResBadge}</td>
          <td class="countdown-cell job-countdown"></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="10" class="no-jobs"><strong>No jobs found</strong>Create a test job to begin: run <code>npm run db:test</code> in the shell, then reload this page.</td></tr>';

  const sel = first
    ? `${esc(first.class_title)} \u00b7 ${esc(first.day_of_week || '')} \u00b7 ${esc(first.class_time || '')} \u00b7 ${esc(first.instructor || '')}`
    : 'None';
  const firstFormattedMeta = first
    ? [first.day_of_week || '', first.class_time || '', ((first.instructor || '').split(' ')[0]) || '']
        .filter(Boolean)
        .reduce((acc, p, i) => i === 0 ? p : i === 1 ? acc + ' at ' + p : acc + ' with ' + p, '')
    : '';
  const { phase: firstPhase, bookingOpenMs: firstBookingOpenMs } =
    first ? jobInfo(first) : { phase: 'unknown', bookingOpenMs: null };

  /* Mobile job cards — grouped into Next / Today / Upcoming sections */
  function renderMjcCard(j, phase, bookingOpenMs, booked, isFirst, isNext) {
    const cls = 'mobile-job-card' + (isFirst ? ' selected' : '') + (isNext ? ' mjc-next' : '');
    return `<div class="${cls}"
        data-id="${j.id}"
        data-title="${esc(j.class_title)}"
        data-day="${esc(j.day_of_week || '')}"
        data-time="${esc(j.class_time || '')}"
        data-instructor="${esc(j.instructor || '')}"
        data-phase="${esc(phase)}"
        data-last-run-at="${esc(j.last_run_at || '')}"
        data-last-result="${esc(j.last_result || '')}"
        data-target-date="${esc(j.target_date || '')}"
        data-is-active="${j.is_active ? '1' : '0'}"
        data-last-success-at="${esc(j.last_success_at || '')}"
        data-last-error-msg="${esc(j.last_error_message || '')}"
        data-booking-open="${bookingOpenMs || ''}"
        onclick="selectMobileCard(this)">
      <div class="mjc-top">
        <div class="mjc-title-group">
          <strong class="mjc-title">${esc(j.class_title)}</strong>
          <span class="mjc-id">#${j.id}</span>
        </div>
        <span class="mjc-status-badge ${j.is_active ? 'mjc-status-active' : 'mjc-status-inactive'}">${j.is_active ? 'Active' : 'Off'}</span>
      </div>
      <div class="mjc-detail">${esc(j.day_of_week || '\u2014')} \u00b7 ${esc(j.class_time || '\u2014')}</div>
      ${j.instructor ? `<div class="mjc-detail">${esc(j.instructor)}</div>` : ''}
      ${j.target_date ? `<div class="mjc-detail mjc-date-line">\uD83D\uDCC5\u00a0${esc(j.target_date)}</div>` : ''}
      <div class="mjc-badges">
        <span class="badge badge-phase-${phase}">${PHASE_LABEL[phase] || phase}</span>
        ${booked ? '<span class="badge-booked">\u2713\u00a0Booked</span>' : ''}
        ${j.last_result ? `<span class="badge badge-result-${j.last_result}">${j.last_result}</span>` : ''}
      </div>
    </div>`;
  }

  const mobileJobCardsHtml = (() => {
    if (!hasJobs) return '<div style="padding:20px;color:#aaa;font-size:14px;text-align:center;">No jobs found.</div>';

    // Today's date in the Pacific timezone (same tz used elsewhere in this file).
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const nowMs    = Date.now();

    // Enrich each job with phase + bookingOpenMs + booked flag (one call each).
    const enriched = jobs.map(j => {
      const { phase, bookingOpenMs } = jobInfo(j);
      return { j, phase, bookingOpenMs, booked: isBookedSS(j) };
    });

    // NEXT: active, unbooked job with the smallest positive time-to-open.
    // Fallback: first active+unbooked job (already-open or phase-based).
    let nextEntry = null;
    let nextDiff  = Infinity;
    enriched.forEach(e => {
      if (!e.j.is_active || e.booked) return;
      if (e.bookingOpenMs) {
        const diff = e.bookingOpenMs - nowMs;
        if (diff > 0 && diff < nextDiff) { nextDiff = diff; nextEntry = e; }
      }
    });
    if (!nextEntry) nextEntry = enriched.find(e => e.j.is_active && !e.booked) || null;
    const nextId = nextEntry ? nextEntry.j.id : null;

    // TODAY: active jobs whose target_date matches today, excluding the "next" job.
    const todayEntries    = enriched.filter(e => e.j.is_active && e.j.target_date === todayStr && e.j.id !== nextId);

    // UPCOMING: everything not in Next or Today.
    const upcomingEntries = enriched.filter(e => {
      if (nextId && e.j.id === nextId) return false;
      if (e.j.is_active && e.j.target_date === todayStr) return false;
      return true;
    });

    function sectionHtml(label, entries) {
      if (!entries.length) return '';
      const isNextSection = label === 'Next';
      const cards = entries.map(e => {
        const isFirst = first && e.j.id === first.id;
        const isNext  = isNextSection && e.j.id === nextId;
        return renderMjcCard(e.j, e.phase, e.bookingOpenMs, e.booked, isFirst, isNext);
      }).join('');
      return `<div class="mjc-section-header">${label}</div>${cards}`;
    }

    const nextSection     = nextEntry ? sectionHtml('Next',     [nextEntry])    : '';
    const todaySection    =             sectionHtml('Today',    todayEntries);
    const upcomingSection =             sectionHtml('Upcoming', upcomingEntries);

    return nextSection + todaySection + upcomingSection || '<div style="padding:20px;color:#aaa;font-size:14px;text-align:center;">No jobs found.</div>';
  })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>YMCA Booker</title>
  <!-- PWA / home-screen meta -->
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="YMCA Booker">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#ffffff">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ---- Single-scroll-container pattern (fixes iOS bounce/snap) ---- */
    html, body {
      height: 100%;
      overflow: hidden;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #eef2f7;
      color: #1a1a2e;
    }
    .main-container {
      height: 100%;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      padding: 28px 16px max(56px, calc(56px + env(safe-area-inset-bottom)));
    }

    .page {
      max-width: 680px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 22px;
    }

    /* ---- page header ---- */
    .page-header { text-align: center; padding: 8px 0 6px; }
    .page-header h1 { font-size: 23px; font-weight: 700; color: #1a1a2e; }
    .page-header p  { font-size: 14px; color: #888; margin-top: 5px; }

    /* ---- Mobile app header (hidden on desktop) ---- */
    #mobile-app-header { display: none; }
    .mah-icon {
      width: 54px; height: 54px;
      border-radius: 14px;
      background: linear-gradient(145deg, #1c2340, #2f5bde);
      display: flex; align-items: center; justify-content: center;
      font-size: 26px;
      flex-shrink: 0;
      box-shadow: 0 2px 10px rgba(47,91,222,0.25);
    }
    .mah-text { display: flex; flex-direction: column; gap: 2px; }
    .mah-title {
      font-size: 22px;
      font-weight: 700;
      color: #1a1a2e;
      letter-spacing: -0.03em;
      line-height: 1.1;
    }
    .mah-sub {
      font-size: 13px;
      color: #888;
      font-weight: 500;
      letter-spacing: 0;
      margin-top: 1px;
    }
    .mah-gear { display: none; }
    .today-widget { display: none; }

    /* ---- next-job global banner ---- */
    .banner         { background:#f1faee; border:1px solid #d8e2dc; padding:10px 14px; border-radius:8px; font-size:14px; }
    .banner.hidden  { display:none; }
    .banner.warning { background:#fff3cd; border-color:#ffeeba; }
    .banner.sniper  { background:#ffe5e5; border-color:#ffb3b3; color:#d62828; font-weight:600; }
    /* Banner inner elements (desktop+mobile) */
    .bnr-dot  { width:7px; height:7px; border-radius:50%; background:#bbb; flex-shrink:0; }
    .bnr-body { display:flex; flex-direction:column; gap:2px; flex:1; }
    .bnr-title { font-size:14px; font-weight:600; color:#1a1a2e; }
    .bnr-sub   { font-size:12px; color:#888; }

    /* ---- scheduler status pill ---- */
    .scheduler-status          { font-size:12px; text-align:right; color:#4caf50; letter-spacing:.02em; }
    .scheduler-status.paused   { color:#e67e22; }

    /* ---- cards ---- */
    .card {
      background: white;
      border-radius: 14px;
      box-shadow: 0 2px 14px rgba(0,0,0,0.07);
      overflow: hidden;   /* fallback for older Safari */
      overflow: clip;     /* clip without creating a scroll container — fixes iOS scroll trap */
    }
    .card-header {
      padding: 16px 24px 12px;
      border-bottom: 1px solid #f0f0f0;
    }
    .card-header h2 {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #999;
    }
    .card-body { padding: 20px 24px; }

    /* ---- selected job ---- */
    .selected-id {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: #457b9d;
      margin-bottom: 5px;
    }
    .selected-summary {
      font-size: 16px;
      font-weight: 600;
      color: #1a1a2e;
      line-height: 1.4;
    }
    .selected-meta {
      font-size: 14px;
      color: #666;
      margin-top: 5px;
    }
    .selected-phase {
      margin-top: 8px;
    }

    /* ---- jobs table ---- */
    .table-scroll {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch; /* smooth momentum scroll on iOS */
      touch-action: pan-x;              /* let iOS pass vertical swipes to the page */
    }
    .jobs-table {
      width: 100%;
      min-width: 580px;          /* prevents columns squishing below this width */
      border-collapse: collapse;
      font-size: 12px;
    }
    .jobs-table th {
      position: sticky;          /* header stays visible while scrolling */
      top: 0;
      background: white;
      z-index: 1;
      text-align: left;
      padding: 10px 11px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #bbb;
      border-bottom: 1px solid #f0f0f0;
      white-space: nowrap;
    }
    .jobs-table td {
      padding: 11px 11px;
      border-bottom: 1px solid #f8f8f8;
      vertical-align: middle;
      color: #333;
      white-space: nowrap;       /* cells never wrap; table scrolls instead */
    }
    .job-row { cursor: pointer; transition: background 0.15s; }
    .job-row:hover  { background: #f5f8ff; }
    .job-row.selected { background: #eef3ff; box-shadow: inset 4px 0 0 #457b9d; }
    .job-row.selected td { color: #1a1a2e; font-weight: 500; }
    .job-id { color: #bbb; font-size: 11px; font-weight: 400; }
    .no-jobs { padding: 36px 24px; text-align: center; color: #aaa; font-size: 14px; line-height: 1.7; }
    .no-jobs strong { display: block; font-size: 16px; color: #999; margin-bottom: 8px; }
    .no-jobs code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 12px; }

    /* Tighten table padding on narrow screens */
    @media (max-width: 480px) {
      .jobs-table { font-size: 11px; }
      .jobs-table th { padding: 8px 8px; font-size: 9px; }
      .jobs-table td { padding: 9px 8px; }
    }

    /* ---- badges ---- */
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 20px;
      white-space: nowrap;
    }
    .badge-active   { background: #d4edda; color: #155724; }
    .badge-inactive { background: #f0f0f0; color: #888; }

    /* Phase badge colours */
    .badge-phase-too_early { background: #f0f0f0; color: #888; }
    .badge-phase-warmup    { background: #fff3cd; color: #856404; }
    .badge-phase-sniper    { background: #ffe5d0; color: #c04a00; }
    .badge-phase-late      { background: #d4edda; color: #155724; }
    .badge-phase-unknown   { background: #f0f0f0; color: #aaa; }

    /* Result badge colours */
    .badge-result-success            { background: #d4edda; color: #155724; }
    .badge-result-already_registered { background: #d1ecf1; color: #0c5460; }
    .badge-result-found_not_open_yet { background: #fff3cd; color: #856404; }
    .badge-result-not_found          { background: #e2e3e5; color: #383d41; }
    .badge-result-error              { background: #f8d7da; color: #721c24; }
    .badge-result-none               { background: transparent; color: #ccc; font-weight: 400; }

    /* Last run / result row in selected-job card */
    .selected-run-info {
      margin-top: 10px;
      font-size: 13px;
      color: #888;
    }
    .selected-run-info .run-label { font-weight: 600; color: #aaa; }
    .col-last-run { font-size: 12px; color: #888; white-space: nowrap; }

    /* ---- actions ---- */
    .actions { display: flex; flex-direction: column; gap: 12px; }
    .btn {
      border: none;
      border-radius: 10px;
      padding: 15px 20px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: opacity 0.15s, background 0.15s;
    }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-primary   { background: #e63946; color: white; }
    .btn-primary:hover:not(:disabled)   { background: #c1121f; }
    .btn-secondary { background: #457b9d; color: white; }
    .btn-secondary:hover:not(:disabled) { background: #2d6080; }
    .btn-muted     { background: #f0f0f0; color: #555; }
    .btn-muted:hover:not(:disabled)     { background: #e0e0e0; }

    /* ---- status ---- */
    .status-body { display: flex; flex-direction: column; gap: 12px; }
    #status {
      font-size: 13px;
      line-height: 1.65;
      white-space: pre-wrap;
      font-family: 'SF Mono', 'Fira Code', monospace;
      color: #555;
      min-height: 44px;
      transition: opacity 150ms ease-out, transform 150ms ease-out;
    }
    #status.running { color: #856404; }
    #status.success { color: #155724; }
    #status.error   { color: #721c24; }
    .status-fade-out { opacity: 0 !important; transform: translateY(4px); }
    .last-run {
      font-size: 12px;
      color: #bbb;
      border-top: 1px solid #f5f5f5;
      padding-top: 10px;
    }
    .last-run strong { color: #999; }

    /* ---- create job form ---- */
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px 18px;
    }
    @media (max-width: 480px) { .form-grid { grid-template-columns: 1fr; } }
    .form-field { display: flex; flex-direction: column; gap: 5px; }
    .form-field.full-width { grid-column: 1 / -1; }
    .form-field label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #bbb;
    }
    .form-field label .req { color: #e63946; margin-left: 2px; }
    .form-field input,
    .form-field select {
      border: 1.5px solid #e8e8e8;
      border-radius: 8px;
      padding: 9px 11px;
      font-size: 14px;
      color: #1a1a2e;
      background: #fafafa;
      outline: none;
      transition: border-color 0.15s;
      width: 100%;
    }
    .form-field input:focus,
    .form-field select:focus { border-color: #457b9d; background: #fff; }
    .form-error {
      background: #f8d7da;
      color: #721c24;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 14px;
    }
    .btn-create  { background: #457b9d; color: white; }
    .btn-create:hover  { background: #2d6080; }
    .btn-danger  { background: #e63946; color: white; }
    .btn-danger:hover:not(:disabled)  { background: #c1121f; }
    .btn-toggle  { background: #f0f0f0; color: #555; }
    .btn-toggle:hover:not(:disabled)  { background: #e0e0e0; }
    .btn-toggle.is-active { background: #fff3cd; color: #856404; }
    .btn-toggle.is-active:hover:not(:disabled) { background: #ffeeba; }

    /* ---- active dot in table ---- */
    .dot {
      display: inline-block;
      width: 7px; height: 7px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
      position: relative; top: -1px;
      flex-shrink: 0;
    }
    .dot-on  { background: #28a745; }
    .dot-off { background: #ccc; }

    /* ---- error message display ---- */
    .row-warn {
      color: #c04a00;
      font-size: 11px;
      margin-left: 4px;
      cursor: default;
    }
    .sel-error-box {
      margin-top: 8px;
      background: #fff5f5;
      border: 1px solid #f5c6cb;
      border-radius: 8px;
      padding: 9px 13px;
      font-size: 12px;
      color: #721c24;
      line-height: 1.5;
      word-break: break-word;
    }
    .sel-error-box .err-label {
      font-weight: 700;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.05em;
      display: block;
      margin-bottom: 3px;
      color: #c0392b;
    }
    /* Compact booked badge for the jobs table */
    .badge-booked {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: #edfaf3;
      border: 1px solid #a8e6c1;
      border-radius: 20px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      color: #1a6b3a;
      margin-top: 3px;
      white-space: nowrap;
    }
    .sel-booked-box {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-top: 8px;
      background: #edfaf3;
      border: 1px solid #a8e6c1;
      border-radius: 20px;
      padding: 4px 11px;
      font-size: 12px;
      font-weight: 600;
      color: #1a6b3a;
    }
    .sel-booked-box .booked-icon { font-size: 14px; }

    /* Countdown timer */
    .countdown-cell {
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      color: #555;
      white-space: nowrap;
    }
    .sel-countdown {
      font-size: 13px;
      color: #777;
      margin-top: 5px;
      font-variant-numeric: tabular-nums;
    }
    /* ---- rolling digit countdown ---- */
    .digit {
      display: inline-block;
      position: relative;
      overflow: hidden;
      height: 1em;
      vertical-align: bottom;
    }
    .digit-inner {
      display: block;
      transition: transform 180ms ease-out;
    }
    .digit.roll-up .digit-inner {
      transform: translateY(-100%);
    }

    .countdown-warning {
      color: #d62828 !important;
      font-weight: 600;
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0%   { opacity: 1; }
      50%  { opacity: 0.4; }
      100% { opacity: 1; }
    }
    /* Next-to-open job highlight */
    .next-job {
      outline: 2px solid #f4a261;
      background: #fff7ec !important;
    }
    /* Sniper mode indicator in Selected Job card */
    .sniper-indicator {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-top: 6px;
      font-size: 13px;
      font-weight: 600;
      color: #d62828;
      animation: pulse 1s infinite;
    }
    /* Pin indicator */
    .pin-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #457b9d;
      margin-top: 4px;
    }
    .unpin-btn {
      background: none;
      border: none;
      font-size: 11px;
      color: #457b9d;
      cursor: pointer;
      text-decoration: underline;
      padding: 0;
    }
    .unpin-btn:hover { color: #1d3557; }

    /* ---- success pulse (selected-job card) ---- */
    .sel-success-pulse {
      display: none;           /* takes no layout space when inactive */
      align-items: center;
      gap: 6px;
      opacity: 0;
      pointer-events: none;
      margin-top: 8px;
    }
    .sel-success-pulse.visible {
      display: inline-flex;    /* shown only for the animation window */
    }
    .sel-success-pulse.active {
      animation: successPulse 1100ms ease-out forwards;
    }
    @keyframes successPulse {
      0%   { opacity: 0;   transform: scale(1.05); }
      15%  { opacity: 1;   transform: scale(1.00); }
      70%  { opacity: 0.9; transform: scale(1.00); }
      100% { opacity: 0;   transform: scale(0.97); }
    }
    .ssp-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #16a34a;
      box-shadow: 0 0 0 3px rgba(22,163,74,0.18);
      flex-shrink: 0;
    }
    .ssp-label {
      font-size: 12px;
      font-weight: 600;
      color: #16a34a;
      letter-spacing: 0.01em;
    }

    /* ---- haptic feedback ---- */
    #haptic-flash {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: rgba(52, 199, 89, 0);
      z-index: 9999;
    }
    .haptic-active {
      animation: hapticFlash 220ms ease-out;
    }
    @keyframes hapticFlash {
      0%   { background: rgba(52, 199, 89, 0.18); }
      100% { background: rgba(52, 199, 89, 0); }
    }
    .haptic-bounce {
      animation: hapticBounce 160ms ease-out;
    }
    @keyframes hapticBounce {
      0%   { transform: scale(1); }
      40%  { transform: scale(1.015); }
      100% { transform: scale(1); }
    }

    /* ---- success checkmark ---- */
    #success-checkmark {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.9);
      font-size: 48px;
      color: #34c759;
      text-shadow: 0 2px 8px rgba(52, 199, 89, 0.3);
      opacity: 0;
      pointer-events: none;
      z-index: 10000;
    }
    .checkmark-show {
      animation: checkmarkSpring 900ms cubic-bezier(0.22, 1.4, 0.36, 1) forwards;
    }
    @keyframes checkmarkSpring {
      0%  { opacity: 0; filter: blur(4px); transform: translate(-50%, -50%) scale(0.7); }
      40% { opacity: 1; filter: blur(0);   transform: translate(-50%, -50%) scale(1.08); }
      65% {                                transform: translate(-50%, -50%) scale(0.96); }
      85% {                                transform: translate(-50%, -50%) scale(1.02); }
      100%{ opacity: 0;                    transform: translate(-50%, -50%) scale(1); }
    }

    /* ---- live-mode global tint ---- */
    body.live-mode {
      background-color: #fff7f7;
    }
    body.live-mode .card {
      border-color: #ffe0e0;
    }
    body.live-mode .banner {
      background: #fff1f1;
    }
    body.live-mode .btn-primary {
      background-color: #e63946;
    }
    body.live-mode .btn-primary:hover {
      background-color: #c1121f;
    }
    #live-mode-indicator {
      font-size: 13px;
      font-weight: 500;
      color: #d62828;
      text-align: center;
      margin-bottom: -8px;
      display: none;
    }
    #live-mode-indicator.visible { display: block; }

    /* ---- dry-run toggle ---- */
    .dry-run-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #fff;
      border-radius: 10px;
      border: 1.5px solid #e0e6ef;
      margin-bottom: 4px;
    }
    .dry-run-label {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .dry-run-label strong { font-size: 15px; color: #1a1a2e; }
    .dry-run-label small  { font-size: 12px; color: #888; }
    .switch {
      position: relative;
      display: inline-block;
      width: 50px;
      height: 28px;
      flex-shrink: 0;
    }
    .switch input { display: none; }
    .slider {
      position: absolute;
      cursor: pointer;
      background-color: #ccc;
      border-radius: 28px;
      top: 0; left: 0; right: 0; bottom: 0;
      transition: background-color 0.2s;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 24px;
      width: 24px;
      left: 2px;
      bottom: 2px;
      background-color: white;
      border-radius: 50%;
      transition: transform 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.25);
    }
    input:checked + .slider { background-color: #34c759; }
    input:checked + .slider:before { transform: translateX(22px); }

    #dry-run-indicator {
      font-size: 13px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
      display: inline-block;
    }
    #dry-run-indicator.mode-dry  { background: #e8f5e9; color: #2e7d32; }
    #dry-run-indicator.mode-live { background: #fff3e0; color: #e65100; }
    /* ---- Recent Failures panel ---- */
    .failure-item {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #f0f0f0;
      cursor: pointer;
    }
    .failure-item:last-child { border-bottom: none; }
    .failure-thumb {
      width: 80px;
      height: 56px;
      border-radius: 8px;
      object-fit: cover;
      border: 1px solid #eee;
      flex-shrink: 0;
      background: #f5f5f5;
    }
    .failure-reason {
      font-size: 12px;
      font-weight: 600;
      color: #d62828;
    }
    .failure-ts {
      font-size: 11px;
      color: #999;
      margin-top: 2px;
    }
    #failure-list-empty {
      font-size: 13px;
      color: #aaa;
      padding: 8px 0;
    }
    /* ---- Trace viewer modal ---- */
    .trace-modal {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    .trace-modal.hidden { display: none; }
    .trace-content {
      background: #fff;
      border-radius: 14px;
      padding: 20px;
      max-width: min(600px, 92vw);
      max-height: 88vh;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    }
    .trace-content img {
      width: 100%;
      border-radius: 8px;
      border: 1px solid #eee;
      margin-bottom: 14px;
      display: block;
    }
    .trace-row { margin-bottom: 8px; font-size: 13px; line-height: 1.5; }
    .trace-row strong { color: #333; }
    .trace-preview {
      background: #f7f7f7;
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 11px;
      font-family: monospace;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 120px;
      overflow-y: auto;
      margin-top: 4px;
      color: #555;
    }
    .trace-close {
      display: block;
      margin-top: 14px;
      text-align: center;
      color: #888;
      font-size: 13px;
      cursor: pointer;
    }
    /* ---- Failure summary ---- */
    #failure-summary-empty { font-size: 13px; color: #aaa; padding: 4px 0; }
    .summary-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 0;
      font-size: 14px;
      border-bottom: 1px solid #f2f2f2;
    }
    .summary-item:last-child { border-bottom: none; }
    .summary-label { color: #444; }
    .summary-count {
      font-weight: 700;
      font-size: 15px;
      min-width: 28px;
      text-align: right;
      border-radius: 10px;
      padding: 1px 8px;
      background: #f0f0f0;
      color: #333;
    }
    .summary-reason-time            .summary-count { background: #fde8e8; color: #c0392b; }
    .summary-reason-instructor      .summary-count { background: #fff3e0; color: #b45309; }
    .summary-reason-time-instructor .summary-count { background: #fbe9e7; color: #922b21; }

    /* ================================================================
       MOBILE-ONLY STYLES  (≤ 640 px)
       ================================================================ */

    /* Responsive visibility helpers */
    .mobile-only   { display: none; }          /* hidden on desktop, shown on mobile */

    @media (max-width: 640px) {
      .mobile-only   { display: block !important; }
      .mobile-hidden { display: none  !important; }

      .page { gap: 16px; }
      .page-header h1 { font-size: 20px; }
      .main-container { padding-left: 12px; padding-right: 12px; }
      .card-body { padding: 16px 16px; }
      .card-header { padding: 14px 16px 10px; }

      /* ---- Mobile job cards (replace table) ---- */
      .desktop-table-card { display: none !important; }
      .mobile-jobs-card   { display: block !important; }

      /* Strip the outer card shell so individual cards float freely */
      .mobile-jobs-card {
        background: transparent;
        border: none;
        box-shadow: none;
        padding: 12px 0 0;
      }
      .mobile-jobs-card .card-header {
        background: transparent;
        border-bottom: none;
        padding-left: 2px;
        padding-bottom: 6px;
      }

      /* Individual floating card */
      .mobile-job-card {
        background: #fff;
        border-radius: 14px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.09), 0 0 1px rgba(0,0,0,0.05);
        margin-bottom: 10px;
        padding: 14px 16px;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      .mobile-job-card:last-child { margin-bottom: 0; }
      .mobile-job-card:active {
        transform: scale(0.978);
        box-shadow: 0 0 2px rgba(0,0,0,0.05);
      }
      .mobile-job-card.selected {
        box-shadow: 0 0 0 2px #0071e3, 0 2px 10px rgba(0,113,227,0.10);
      }

      /* Card internal layout */
      .mjc-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 7px;
      }
      .mjc-title-group { flex: 1; }
      .mjc-title { font-size: 15px; font-weight: 700; color: #1a1a2e; display: block; }
      .mjc-id    { font-size: 11px; color: #c8c8c8; font-weight: 400; display: block; margin-top: 1px; }
      .mjc-status-badge {
        font-size: 11px;
        font-weight: 600;
        padding: 3px 9px;
        border-radius: 20px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .mjc-status-active   { background: #e6f4ea; color: #2a7a36; }
      .mjc-status-inactive { background: #f2f2f7; color: #aaa; }
      .mjc-detail {
        font-size: 13px;
        color: #666;
        margin-bottom: 3px;
        line-height: 1.45;
      }
      .mjc-date-line { color: #888; }
      .mjc-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }

      /* ---- Mobile job section headers ---- */
      .mjc-section-header {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: #b0b0bb;
        padding: 18px 4px 8px;
      }
      .mjc-section-header:first-child { padding-top: 4px; }

      /* "Next" card: subtle blue accent — slightly stronger than a regular card */
      .mobile-job-card.mjc-next {
        box-shadow: 0 0 0 1.5px rgba(0,113,227,0.28), 0 3px 16px rgba(0,113,227,0.09);
      }
      /* Keep selected + next combined state clean */
      .mobile-job-card.mjc-next.selected {
        box-shadow: 0 0 0 2px #0071e3, 0 3px 16px rgba(0,113,227,0.14);
      }

      /* ---- More Actions button (mobile) ---- */
      .mobile-more-btn { display: block !important; }

      /* ================================================================
         MOBILE APP-LIKE POLISH
         ================================================================ */

      /* More breathing room between sections */
      .page { gap: 20px; }

      /* Safe-area-aware top padding on iPhone */
      .main-container {
        padding-top: max(20px, calc(14px + env(safe-area-inset-top)));
      }

      /* Compact app-name header — not the focal point on mobile */
      .page-header { padding: 0; }
      .page-header h1 { font-size: 17px; }
      .page-header p  { display: none; }

      /* Live-mode indicator duplicates dry-run badge — hide on mobile */
      #live-mode-indicator { display: none; }

      /* Selected Job: remove admin label, bigger hero typography */
      .selected-job-card .card-header { display: none; }
      .selected-job-card .card-body   { padding: 20px 18px 18px; }
      .selected-job-card .selected-summary {
        font-size: 20px;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: -0.01em;
      }
      .selected-job-card .selected-meta {
        font-size: 14px;
        margin-top: 6px;
        line-height: 1.5;
        color: #666;
      }
      .selected-job-card .sel-countdown { font-size: 14px; margin-top: 6px; }

      /* Selected job card slightly stronger shadow = hero card */
      .selected-job-card {
        box-shadow: 0 3px 20px rgba(0,0,0,0.10);
      }

    }

    /* Desktop: hide mobile cards and More Actions button */
    @media (min-width: 641px) {
      .mobile-jobs-card  { display: none !important; }
      .mobile-more-btn   { display: none !important; }
    }

    /* Now-tab premium cards are mobile-only — hide above 768px (desktop uses legacy cards) */
    @media (min-width: 769px) {
      #now-hero-card,
      #now-progress-card,
      #now-action-row,
      #now-detail-card  { display: none !important; }
    }

    /* ---- More Actions bottom sheet ---- */
    .moa-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.42);
      z-index: 1100;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.24s ease;
    }
    .moa-backdrop.open { opacity: 1; pointer-events: auto; }
    .moa-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: #fff;
      border-radius: 20px 20px 0 0;
      padding: 0 0 max(20px, env(safe-area-inset-bottom));
      z-index: 1200;
      box-shadow: 0 -4px 32px rgba(0,0,0,0.14);
      transform: translateY(100%);
      transition: transform 0.30s cubic-bezier(0.32, 0.72, 0, 1);
      max-height: 86vh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .moa-panel.open { transform: translateY(0); }
    .moa-handle {
      width: 36px; height: 5px;
      background: #e0e0e0;
      border-radius: 3px;
      margin: 10px auto 4px;
    }
    .moa-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #bbb;
      text-align: center;
      padding: 8px 16px 12px;
    }
    .moa-items {
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding: 0 14px;
      padding-bottom: 4px;
    }
    .moa-items .btn { font-size: 15px; padding: 14px 16px; }
    /* Section group labels */
    .moa-group-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: #bbb;
      padding: 14px 4px 6px;
    }
    /* Thin divider between groups */
    .moa-sep {
      height: 1px;
      background: #ebebeb;
      margin: 2px 0;
    }

    /* ---- Settings bottom sheet ---- */
    .stg-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.42);
      z-index: 1100;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.24s ease;
    }
    .stg-backdrop.open { opacity: 1; pointer-events: auto; }
    .stg-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: #f2f2f7;
      border-radius: 20px 20px 0 0;
      padding: 0 0 max(20px, env(safe-area-inset-bottom));
      z-index: 1200;
      box-shadow: 0 -4px 32px rgba(0,0,0,0.14);
      transform: translateY(100%);
      transition: transform 0.30s cubic-bezier(0.32, 0.72, 0, 1);
      max-height: 86vh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .stg-panel.open { transform: translateY(0); }
    .stg-handle {
      width: 36px; height: 5px;
      background: #c7c7cc;
      border-radius: 3px;
      margin: 10px auto 4px;
      cursor: pointer;
    }
    .stg-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8e8e93;
      text-align: center;
      padding: 8px 16px 12px;
    }
    .stg-group-label {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #8e8e93;
      padding: 16px 20px 6px;
    }
    .stg-group {
      background: #fff;
      border-radius: 12px;
      margin: 0 16px 4px;
      overflow: hidden;
    }
    .stg-row {
      display: flex;
      align-items: center;
      padding: 13px 16px;
      gap: 12px;
    }
    .stg-row-label {
      flex: 1;
      font-size: 16px;
      color: #1c1c1e;
      font-weight: 400;
    }
    .stg-divider {
      height: 1px;
      background: #e5e5ea;
      margin-left: 16px;
    }
    .stg-row-sub {
      font-size: 12px;
      color: #8e8e93;
      padding: 0 16px 12px;
    }
    .stg-row-readonly {
      font-size: 15px;
      color: #3c3c43;
      padding: 13px 16px;
    }
    .mah-gear {
      margin-left: auto;
      flex-shrink: 0;
      background: none;
      border: none;
      font-size: 22px;
      color: #8e8e93;
      padding: 6px 2px;
      cursor: pointer;
      line-height: 1;
    }

    /* ================================================================
       MOBILE MODE SYSTEM  (Normal / Focus / StandBy)
       ================================================================ */
    @media (max-width: 768px) {
      /* Sections hidden by the JS mode controller */
      .mobile-section-hidden { display: none !important; }

      /* Mode switcher card — visible at full mobile width */
      #mode-switcher { display: block !important; }

      /* ---- Mobile app header ---- */
      #mobile-app-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: max(18px, calc(12px + env(safe-area-inset-top))) 4px 14px;
      }
      /* Main container: header owns the top safe-area, so container needs no top pad */
      .main-container { padding-top: 0; }
      /* Hide the desktop-style page header entirely on mobile */
      .page-header { display: none; }
      /* Gear button visible on mobile */
      .mah-gear { display: block; }

      /* ---- Mobile refresh row ---- */
      #mobile-refresh-row {
        display: flex !important;        /* override mobile-only's display:block */
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 2px 6px;
      }
      #mobile-refresh-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        background: rgba(0,0,0,0.055);
        border: none;
        border-radius: 20px;
        padding: 8px 16px;
        font-size: 14px;
        font-weight: 500;
        color: #444;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        transition: background 0.14s ease, opacity 0.14s ease;
        min-height: 36px;
      }
      #mobile-refresh-btn:active  { background: rgba(0,0,0,0.11); }
      #mobile-refresh-btn:disabled { opacity: 0.45; pointer-events: none; }
      .mrr-icon {
        font-size: 15px;
        display: inline-block;
        line-height: 1;
        transform-origin: center;
      }
      #mobile-refresh-btn.spinning .mrr-icon {
        animation: mrr-spin 0.65s linear infinite;
      }
      @keyframes mrr-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
      .mrr-updated {
        font-size: 12px;
        color: #c0c0c8;
        white-space: nowrap;
        padding-right: 2px;
      }

      /* ---- Mobile top banner (sticky, iOS card style) ---- */
      #next-job-banner:not(.hidden) {
        display: flex;
        align-items: center;
        gap: 11px;
        position: sticky;
        top: 8px;
        z-index: 200;
        background: rgba(255,255,255,0.97);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border: 1px solid rgba(0,0,0,0.07);
        border-radius: 13px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.08);
        padding: 10px 14px;
        color: #1a1a2e;
        font-size: 14px;
      }
      /* State-specific dot colors */
      #next-job-banner .bnr-dot                 { background: #bbb; }
      #next-job-banner.warning .bnr-dot          { background: #f59e0b; }
      #next-job-banner.sniper  .bnr-dot          { background: #16a34a; }
      /* State-specific sub-text colors */
      #next-job-banner.warning .bnr-sub          { color: #d97706; }
      #next-job-banner.sniper  .bnr-sub          { color: #16a34a; font-weight: 600; }
      /* Reset desktop color overrides that bleed in via .sniper class */
      #next-job-banner.sniper  { color: #1a1a2e; font-weight: normal; }
      #next-job-banner.warning { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.07); }
      /* Slightly larger type in the banner for easy one-glance reading */
      #next-job-banner .bnr-title { font-size: 15px; }
      #next-job-banner .bnr-sub   { font-size: 13px; }
      #next-job-banner:not(.hidden) { padding: 12px 16px; }

      /* ---- Tab switcher (Now / Plan / Tools) ---- */
      .tab-switcher-bar {
        padding: 0 0 4px;
      }
      .tab-seg {
        display: flex;
        background: #f0f4f8;
        border-radius: 12px;
        padding: 3px;
        gap: 2px;
      }
      .tab-seg-btn {
        flex: 1;
        border: none;
        background: transparent;
        border-radius: 10px;
        padding: 11px 8px;
        font-size: 14px;
        font-weight: 600;
        color: #aaa;
        cursor: pointer;
        transition: background 0.15s, color 0.15s, box-shadow 0.15s;
        letter-spacing: -0.01em;
      }
      .tab-seg-btn.active {
        background: white;
        color: #1a1a2e;
        box-shadow: 0 1px 6px rgba(0,0,0,0.14);
      }
      .tab-seg-btn:active:not(.active) { background: rgba(0,0,0,0.04); }

      /* ---- Tab section visibility ---- */
      .tab-section-hidden { display: none !important; }
      /* Sticky run bar hidden when not in Now tab */
      #sticky-run-bar.srb-hidden { display: none !important; }
      /* Today widget superseded by Now tab focused hero card */
      #today-widget { display: none !important; }

      /* Hide legacy data-source cards on mobile (JS still reads their hidden elements) */
      .sel-card-legacy   { display: none !important; }
      .now-status-legacy { display: none !important; }

      /* Hide Now tab premium cards in desktop (desktop shows selected-job-card instead) */
      /* These rules are inside @media max-width:768px, so they apply on mobile only.   */
      /* No desktop override needed — the desktop simply shows the non-now-tab cards.  */

      /* ================================================================
         NOW TAB — Premium iOS-style redesigned components
         ================================================================ */

      /* --- Hero card --- */
      .now-hero-card {
        border-radius: 22px !important;
        box-shadow: 0 2px 18px rgba(0,0,0,0.07) !important;
        padding: 26px 22px 28px !important;
        margin-bottom: 10px;
      }
      .nhc-state-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 16px;
      }
      .nhc-state-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .nhc-state-dot.dot-green { background:#34c759; box-shadow:0 0 0 3px rgba(52,199,89,.20); }
      .nhc-state-dot.dot-amber { background:#ff9f0a; box-shadow:0 0 0 3px rgba(255,159,10,.20); }
      .nhc-state-dot.dot-red   { background:#ff3b30; box-shadow:0 0 0 3px rgba(255,59,48,.20); }
      .nhc-state-dot.dot-gray  { background:#aeaeb2; box-shadow:0 0 0 3px rgba(174,174,178,.20); }
      .nhc-state-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: #8e8e93;
      }
      .nhc-mode-pill {
        margin-left: auto;
        font-size: 11px;
        font-weight: 600;
        background: #eff3ff;
        color: #2c5de5;
        border-radius: 10px;
        padding: 3px 9px;
      }
      .nhc-class-name {
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.03em;
        color: #1a1a2e;
        line-height: 1.15;
      }
      .nhc-class-meta {
        font-size: 15px;
        color: #8e8e93;
        margin-top: 5px;
        line-height: 1.45;
      }
      .nhc-cd-block { margin-top: 26px; }
      .nhc-countdown-label {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: #c7c7cc;
        margin-bottom: 4px;
      }
      .nhc-countdown {
        font-size: 50px;
        font-weight: 700;
        letter-spacing: -3px;
        color: #1a1a2e;
        line-height: 1;
      }
      .nhc-countdown.nhc-cd-booked { font-size: 22px; letter-spacing: 0; color: #34c759; }
      .nhc-countdown.nhc-cd-now    { font-size: 38px; letter-spacing: -1px; color: #ff9f0a; }
      .nhc-sub-text {
        font-size: 13px;
        color: #c7c7cc;
        margin-top: 14px;
        line-height: 1.55;
      }

      /* --- Progress steps card --- */
      .now-progress-card {
        border-radius: 16px !important;
        box-shadow: none !important;
        background: #f8f8fa !important;
        padding: 0 !important;
        overflow: hidden;
        margin-bottom: 10px;
      }
      .nps-step {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 13px 18px;
      }
      .nps-step + .nps-step { border-top: 1px solid #efefef; }
      .nps-icon {
        font-size: 15px;
        width: 22px;
        text-align: center;
        flex-shrink: 0;
        font-style: normal;
      }
      .nps-label { font-size: 14px; font-weight: 500; line-height: 1.3; }
      .nps-done    .nps-icon  { color: #34c759; }
      .nps-done    .nps-label { color: #3c3c43; }
      .nps-current .nps-icon  { color: #007aff; }
      .nps-current .nps-label { color: #1a1a2e; font-weight: 600; }
      .nps-upcoming .nps-icon  { color: #c7c7cc; }
      .nps-upcoming .nps-label { color: #c7c7cc; }
      .nps-error   .nps-icon  { color: #ff3b30; }
      .nps-error   .nps-label { color: #ff3b30; }

      /* --- Action row --- */
      .now-action-row {
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
      }
      .nar-btn {
        flex: 1;
        border: none;
        border-radius: 14px;
        font-size: 15px;
        font-weight: 600;
        padding: 16px 8px;
        cursor: pointer;
        transition: opacity 0.15s;
        letter-spacing: -0.01em;
      }
      .nar-btn:active { opacity: 0.7; }
      .nar-pause, .nar-resume { background: #f2f2f7; color: #1a1a2e; }
      .nar-cancel             { background: #f2f2f7; color: #636366; }

      /* --- Secondary detail card --- */
      .now-detail-card {
        border-radius: 16px !important;
        box-shadow: none !important;
        background: #f8f8fa !important;
        padding: 0 !important;
        overflow: hidden;
        margin-bottom: 10px;
      }
      .ndc-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 18px;
      }
      .ndc-sep { height: 1px; background: #efefef; margin: 0 18px; }
      .ndc-label { font-size: 14px; color: #8e8e93; }
      .ndc-val   { font-size: 14px; color: #3c3c43; font-weight: 500; text-align: right; max-width: 58%; }

      /* ================================================================
         FOCUS MODE — Apple-like spacious layout
         Sections shown: banner + selected-job card + status + sticky bar
         ================================================================ */

      /* Hero card: generous padding, stronger shadow */
      body.mode-focus .selected-job-card {
        box-shadow: 0 4px 30px rgba(0,0,0,0.11);
        border-radius: 18px;
      }
      body.mode-focus .selected-job-card .card-body {
        padding: 28px 24px 32px;
      }

      /* Job ID eyebrow */
      body.mode-focus .selected-job-card .selected-id {
        font-size: 11px;
        letter-spacing: 0.08em;
        margin-bottom: 10px;
      }

      /* Class title — hero size */
      body.mode-focus .selected-job-card .selected-summary {
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.03em;
        line-height: 1.15;
      }

      /* Day · time · instructor */
      body.mode-focus .selected-job-card .selected-meta {
        font-size: 16px;
        margin-top: 10px;
        line-height: 1.65;
        color: #666;
      }

      /* Target date */
      body.mode-focus .selected-job-card .selected-date {
        font-size: 14px !important;
        margin-top: 6px !important;
      }

      /* Phase badge row */
      body.mode-focus .selected-job-card .selected-phase {
        margin-top: 14px;
      }

      /* Countdown — big, readable */
      body.mode-focus .selected-job-card .sel-countdown {
        font-size: 22px;
        font-weight: 600;
        color: #1a1a2e;
        margin-top: 22px;
        letter-spacing: -0.02em;
        line-height: 1.35;
      }

      /* Booked box */
      body.mode-focus .selected-job-card .sel-booked-box {
        font-size: 16px;
        padding: 12px 16px;
        margin-top: 16px;
        border-radius: 12px;
      }

      /* Last run info */
      body.mode-focus .selected-job-card .selected-run-info {
        margin-top: 18px;
        font-size: 13px;
        color: #999;
      }

      /* Error / info box */
      body.mode-focus .selected-job-card .sel-error-box {
        margin-top: 16px;
        border-radius: 10px;
      }

      /* Mode switcher: slimmer in focus mode */
      body.mode-focus #mode-switcher .card-body { padding: 8px 10px; }

      /* Sticky bar primary button: full-width in focus (hide secondary) */
      body.mode-focus #sticky-run-bar .srb-secondary { display: none !important; }
      body.mode-focus #sticky-run-bar .srb-primary   { font-size: 17px; min-height: 56px; border-radius: 16px; }

      /* ================================================================
         STANDBY MODE — Apple lock-screen / glanceable feel
         ================================================================ */

      /* Card shell: no shadow noise, big rounded corners */
      body.mode-standby .selected-job-card {
        box-shadow: none;
        border-radius: 24px;
        background: #ffffff;
      }
      /* Hide the card's "SELECTED JOB" header bar in StandBy */
      body.mode-standby .selected-job-card .card-header { display: none !important; }
      /* Center everything inside the card */
      body.mode-standby .selected-job-card .card-body {
        padding: 40px 24px 44px;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      /* Job # badge — hide (too noisy in StandBy) */
      body.mode-standby .selected-job-card .selected-id { display: none !important; }
      /* Class title — large & bold */
      body.mode-standby .selected-job-card .selected-summary {
        font-size: 26px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: #1a1a2e;
        line-height: 1.2;
      }
      /* Day · time · instructor — softer secondary */
      body.mode-standby .selected-job-card .selected-meta {
        font-size: 15px;
        color: #8e8e93;
        margin-top: 8px;
        line-height: 1.5;
      }
      /* Target date */
      body.mode-standby .selected-job-card .selected-date {
        font-size: 13px;
        color: #bbb;
        margin-top: 4px;
      }
      /* Phase badge row */
      body.mode-standby .selected-job-card .selected-phase { margin-top: 18px; }
      /* Sniper indicator */
      body.mode-standby .selected-job-card .sniper-indicator { margin-top: 14px; font-size: 15px; }
      /* === COUNTDOWN: the hero element === */
      body.mode-standby .selected-job-card .sel-countdown {
        font-size: 54px;
        font-weight: 700;
        color: #1a1a2e;
        margin-top: 32px;
        letter-spacing: -3px;
        line-height: 1;
      }
      /* Booked confirmation block */
      body.mode-standby .selected-job-card .sel-booked-box {
        font-size: 17px;
        margin-top: 28px;
        border-radius: 16px;
        padding: 16px 22px;
        width: 100%;
        box-sizing: border-box;
      }
      /* Last-run info line — very dim */
      body.mode-standby .selected-job-card .selected-run-info {
        font-size: 11px;
        color: #c0c0c5;
        margin-top: 20px;
      }
      /* Error box */
      body.mode-standby .selected-job-card .sel-error-box {
        font-size: 13px;
        margin-top: 18px;
        border-radius: 12px;
        width: 100%;
        box-sizing: border-box;
      }
      /* Mode switcher: slimmer strip in StandBy */
      body.mode-standby #mode-switcher .card-body { padding: 8px 10px; }
      /* Sticky run bar — full-width primary, larger tap target */
      body.mode-standby #sticky-run-bar .srb-secondary { display: none !important; }
      body.mode-standby #sticky-run-bar .srb-primary {
        font-size: 18px;
        font-weight: 700;
        min-height: 58px;
        border-radius: 18px;
      }

      /* ================================================================
         TODAY WIDGET
         ================================================================ */
      .today-widget {
        display: block;
        background: #fff;
        border-radius: 18px;
        padding: 16px 18px 18px;
        box-shadow: 0 3px 20px rgba(0,0,0,0.08);
        margin-bottom: 8px;
      }
      .tw-top-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .tw-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: #8e8e93;
      }
      .tw-mode-badge {
        font-size: 11px;
        font-weight: 600;
        color: #888;
        background: #f5f5f7;
        border-radius: 10px;
        padding: 2px 8px;
      }
      body.live-mode .tw-mode-badge { display: none; }
      .tw-title {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: #1a1a2e;
        margin-top: 7px;
        line-height: 1.2;
      }
      .tw-meta {
        font-size: 14px;
        color: #666;
        margin-top: 5px;
        line-height: 1.5;
      }
      .tw-bottom-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 14px;
      }
      .tw-pill {
        display: inline-block;
        font-size: 12px;
        font-weight: 600;
        background: #f0f4ff;
        color: #2f5bde;
        border-radius: 20px;
        padding: 4px 10px;
        letter-spacing: 0.01em;
      }
      .tw-pill.booked  { background: #e6f9ee; color: #16a34a; }
      .tw-pill.opening { background: #fff3e0; color: #c04a00; }

      /* Focus mode: widget is primary card */
      body.mode-focus .today-widget { padding: 20px 20px 24px; }
      body.mode-focus .tw-title     { font-size: 26px; }
      body.mode-focus .tw-pill      { font-size: 13px; padding: 5px 12px; }
      /* Hide the separate selected-job-card in Focus — widget covers it */
      body.mode-focus .selected-job-card { display: none !important; }

      /* StandBy mode: hide widget (StandBy is a pure clock face) */
      body.mode-standby .today-widget { display: none !important; }
    }

    /* ---- Sticky bottom run bar ---- */
    #sticky-run-bar {
      display: none;               /* hidden on desktop */
    }
    @media (max-width: 768px) {
      #sticky-run-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        position: fixed;
        left: 0; right: 0; bottom: 0;
        z-index: 900;
        background: rgba(255,255,255,0.96);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -2px 16px rgba(0,0,0,0.10);
        padding: 12px 16px max(20px, calc(12px + env(safe-area-inset-bottom)));
      }
      #sticky-run-bar .srb-primary {
        flex: 1;
        background: #0071e3;
        color: white;
        border: none;
        border-radius: 13px;
        font-size: 15px;
        font-weight: 600;
        min-height: 52px;
        cursor: pointer;
        padding: 0 18px;
        letter-spacing: -0.01em;
      }
      #sticky-run-bar .srb-primary:active { background: #005bb5; }
      #sticky-run-bar .srb-secondary {
        flex-shrink: 0;
        background: #f2f2f7;
        color: #444;
        border: none;
        border-radius: 13px;
        font-size: 13px;
        font-weight: 600;
        min-height: 52px;
        min-width: 110px;
        cursor: pointer;
        padding: 0 12px;
        letter-spacing: -0.01em;
      }
      #sticky-run-bar .srb-secondary:active { background: #e1e1e8; }

      /* Hide duplicate run buttons in Actions card — they live in the sticky bar.
         Note: .mobile-hidden only fires at ≤640px (existing breakpoint), so we
         suppress these two buttons directly here for the 641–768px range as well.
         Expanding .mobile-hidden globally to 768px would hide unrelated elements
         (Force Run, Delete, etc.) on tablets, which is not desired. */
      #btn-run, #btn-run-sched-sel { display: none !important; }

      /* Extra bottom padding so content clears the sticky bar */
      .main-container {
        padding-bottom: max(110px, calc(100px + env(safe-area-inset-bottom)));
      }
    }
  </style>
</head>
<body>
  <div id="haptic-flash"></div>
  <div id="success-checkmark">&#x2713;</div>

  <!-- More Actions bottom sheet (mobile) -->
  <div id="moa-backdrop" class="moa-backdrop" onclick="closeMoreActions()"></div>
  <div id="moa-panel" class="moa-panel">
    <div class="moa-handle"></div>
    <p class="moa-title">More Actions</p>
    <div class="moa-items">

      <!-- Section 1: Scheduler -->
      <div class="moa-group-label">Scheduler</div>
      <button class="btn btn-muted" id="ma-pause"  onclick="pauseScheduler();  closeMoreActions()">&#9646;&#9646; Pause Scheduler</button>
      <button class="btn btn-muted" id="ma-resume" onclick="resumeScheduler(); closeMoreActions()" style="display:none">&#9654; Resume Scheduler</button>
      <button class="btn btn-secondary" onclick="runRegister(); closeMoreActions()">Run Default Job</button>

      <div class="moa-sep"></div>

      <!-- Section 2: Job state -->
      <div class="moa-group-label">Job</div>
      <button class="btn btn-toggle ${first && first.is_active ? 'is-active' : ''}" id="ma-toggle" onclick="toggleActive(); closeMoreActions()">${first ? (first.is_active ? 'Deactivate Job' : 'Activate Job') : 'Toggle Active'}</button>
      <button class="btn btn-muted" onclick="cleanTestJobs(); closeMoreActions()">Clean Old Test Jobs</button>

      <div class="moa-sep"></div>

      <!-- Section 3: Destructive -->
      <div class="moa-group-label">Danger Zone</div>
      <button class="btn btn-danger" onclick="forceRunSelected(); closeMoreActions()">&#9888; Force Run (Ignore Rules)</button>
      <button class="btn btn-danger" onclick="deleteSelectedJob(); closeMoreActions()">Delete Job</button>

    </div>
  </div>

  <!-- Settings bottom sheet (mobile) -->
  <div id="stg-backdrop" class="stg-backdrop" onclick="closeSettings()"></div>
  <div id="stg-panel" class="stg-panel">
    <div class="stg-handle" onclick="closeSettings()"></div>
    <p class="stg-title">Settings</p>

    <!-- App Mode -->
    <div class="stg-group-label">App Mode</div>
    <div class="stg-group">
      <div class="stg-row">
        <div class="stg-row-label">Dry Run</div>
        <label class="switch">
          <input type="checkbox" id="stg-dry-run" ${dryRunEnabled ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
      <div class="stg-divider"></div>
      <div class="stg-row">
        <div class="stg-row-label">Haptic Feedback</div>
        <label class="switch">
          <input type="checkbox" id="stg-haptic" checked>
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- Automation -->
    <div class="stg-group-label">Automation</div>
    <div class="stg-group">
      <div class="stg-row">
        <div class="stg-row-label">Pause Scheduler</div>
        <label class="switch">
          <input type="checkbox" id="stg-pause">
          <span class="slider"></span>
        </label>
      </div>
      <div class="stg-row-sub" id="stg-sched-status">&#9654; Scheduler running</div>
    </div>

    <!-- Status -->
    <div class="stg-group-label">Status</div>
    <div class="stg-group">
      <div class="stg-row-readonly" id="stg-mode-status">${dryRunEnabled ? 'Dry Run Mode' : 'Live Mode'}</div>
    </div>
  </div>

  <div class="main-container">
  <div class="page">

    <!-- Mobile app-style header: hidden on desktop, shown on mobile -->
    <div id="mobile-app-header">
      <div class="mah-text">
        <div class="mah-title">YMCA Booker</div>
        <div class="mah-sub" id="mah-status">Monitoring</div>
      </div>
    </div>

    <!-- Mobile refresh control: shown in Tools tab only -->
    <div id="mobile-refresh-row" class="mobile-only" data-tab-section="tools">
      <button id="mobile-refresh-btn" onclick="mobileRefresh()" aria-label="Refresh dashboard">
        <span class="mrr-icon" aria-hidden="true">&#x21BB;</span>
        <span id="mrr-label">Refresh</span>
      </button>
      <span id="mrr-updated" class="mrr-updated"></span>
    </div>

    <!-- Today widget: glanceable top card (mobile only, hidden on desktop) -->
    <div id="today-widget" class="today-widget mobile-only">
      <div class="tw-top-row">
        <span class="tw-label" id="tw-label">NEXT CLASS</span>
        <span class="tw-mode-badge" id="tw-mode-badge">${dryRunEnabled ? 'Dry Run' : ''}</span>
      </div>
      <div class="tw-title" id="tw-title">${first ? esc(first.class_title) : '\u2014'}</div>
      <div class="tw-meta"  id="tw-meta"></div>
      <div class="tw-bottom-row">
        <span class="tw-pill" id="tw-pill">\u2014</span>
      </div>
    </div>

    <div class="page-header">
      <h1>&#x1F9D8; YMCA BOT</h1>
      <p>Booking control panel</p>
    </div>
    <div id="live-mode-indicator">&#x1F680; Live Mode Active</div>

    <!-- Mobile tab switcher: Now / Plan / Tools (hidden on desktop) -->
    <div id="tab-switcher" class="mobile-only tab-switcher-bar">
      <div class="tab-seg">
        <button class="tab-seg-btn active" data-tab="now"   onclick="setTab('now')">Now</button>
        <button class="tab-seg-btn"        data-tab="plan"  onclick="setTab('plan')">Plan</button>
        <button class="tab-seg-btn"        data-tab="tools" onclick="setTab('tools')">Tools</button>
      </div>
    </div>

    <div id="next-job-banner" class="banner hidden" data-tab-section="plan"></div>

    <!-- Legacy status bar — hidden on mobile, kept for JS targets -->
    <div class="now-status-legacy" style="display:flex;align-items:center;justify-content:flex-end;gap:10px;">
      <span id="dry-run-indicator" class="${dryRunEnabled ? 'mode-dry' : 'mode-live'}">${dryRunEnabled ? '&#x1F9EA; Dry Run' : '&#x1F680; Live'}</span>
      <div id="scheduler-status" class="scheduler-status" style="margin:0">&#9654; Scheduler running</div>
    </div>

    <!-- ====================================================
         NOW TAB — Hero redesign
         These cards are the primary Now tab UI on mobile.
         The legacy selected-job-card below provides JS targets.
         ==================================================== -->

    <!-- Hero status card -->
    <div id="now-hero-card" class="card now-hero-card" data-tab-section="now">
      <div class="nhc-state-row">
        <span class="nhc-state-dot dot-green" id="nhc-dot"></span>
        <span class="nhc-state-label" id="nhc-state">Monitoring</span>
        <span class="nhc-mode-pill" id="nhc-mode-pill"${!dryRunEnabled ? ' style="display:none"' : ''}>Dry Run</span>
      </div>
      <div class="nhc-class-name" id="nhc-class-name">${first ? esc(first.class_title) : '—'}</div>
      <div class="nhc-class-meta" id="nhc-class-meta">${firstFormattedMeta}</div>
      <div class="nhc-cd-block">
        <div class="nhc-countdown-label" id="nhc-countdown-label">Next action in</div>
        <div class="nhc-countdown" id="nhc-countdown">—</div>
      </div>
      <div class="nhc-sub-text" id="nhc-sub-text">Will automatically attempt booking when registration opens</div>
    </div>

    <!-- Progress steps -->
    <div id="now-progress-card" class="card now-progress-card" data-tab-section="now">
      <div class="nps-step nps-current" id="nps-0">
        <span class="nps-icon">&#9679;</span>
        <span class="nps-label">Class found</span>
      </div>
      <div class="nps-step nps-upcoming" id="nps-1">
        <span class="nps-icon">&#9675;</span>
        <span class="nps-label">Waiting for registration window</span>
      </div>
      <div class="nps-step nps-upcoming" id="nps-2">
        <span class="nps-icon">&#9675;</span>
        <span class="nps-label">Booking attempt</span>
      </div>
    </div>

    <!-- Action row -->
    <div id="now-action-row" class="now-action-row" data-tab-section="now">
      <button class="nar-btn nar-pause"  id="nar-pause"  onclick="pauseScheduler()">Pause Booking</button>
      <button class="nar-btn nar-resume" id="nar-resume" onclick="resumeScheduler()" style="display:none">Resume Booking</button>
      <button class="nar-btn nar-cancel" id="nar-cancel" onclick="deactivateSelectedJob()">Cancel Booking</button>
    </div>

    <!-- Secondary detail card -->
    <div id="now-detail-card" class="card now-detail-card" data-tab-section="now">
      <div class="ndc-row">
        <span class="ndc-label">Last checked</span>
        <span class="ndc-val" id="ndc-last-checked">${first ? fmtRunAt(first.last_run_at) : '—'}</span>
      </div>
      <div class="ndc-sep"></div>
      <div class="ndc-row">
        <span class="ndc-label">Status</span>
        <span class="ndc-val" id="ndc-status-val">—</span>
      </div>
      <div class="ndc-sep"></div>
      <div class="ndc-row">
        <span class="ndc-label">Automatic retry</span>
        <span class="ndc-val">Enabled</span>
      </div>
    </div>

    <!-- Legacy selected-job card — hidden on mobile, keeps JS data targets intact -->
    <div class="card selected-job-card sel-card-legacy">
      <div class="card-header"><h2>Selected Job</h2></div>
      <div class="card-body">
        <div class="selected-id"      id="sel-id">${first ? 'Job #' + first.id : ''}</div>
        <div class="selected-summary" id="sel-title">${first ? esc(first.class_title) : 'None'}</div>
        <div class="selected-meta"    id="sel-meta">${sel}</div>
        <div class="selected-date"    id="sel-date" style="font-size:13px;color:#888;margin-top:4px;">Date: <strong>${first && first.target_date ? esc(first.target_date) : '\u2014'}</strong></div>
        <div class="selected-phase"   id="sel-phase"><span class="badge badge-phase-${firstPhase}">${PHASE_LABEL[firstPhase] || firstPhase}</span></div>
        <div class="sel-countdown"    id="sel-countdown"></div>
        <div class="sniper-indicator" id="sel-sniper" style="display:none">&#128293; Sniper mode active</div>
        <div id="sel-booked-box" class="sel-booked-box" ${firstIsBooked ? '' : 'style="display:none"'}>
          <span class="booked-icon">&#10003;</span>
          <span id="sel-booked-text">${first && first.target_date ? `Booked for ${esc(first.target_date)}` : 'Booked this week'}</span>
        </div>
        <div id="sel-success-pulse" class="sel-success-pulse">
          <span class="ssp-dot"></span><span class="ssp-label">Booked!</span>
        </div>
        <div class="pin-indicator" id="sel-pin-box" style="display:none">
          &#128204; Pinned&nbsp;<button class="unpin-btn" onclick="unpin()">Unpin</button>
        </div>
        <div class="selected-run-info">
          <span class="run-label">Last run:</span>
          <span id="sel-last-run">${first ? fmtRunAt(first.last_run_at) : 'Never'}</span>
          &nbsp;&middot;&nbsp;
          <span class="run-label">Result:</span>
          <span id="sel-last-result">${first ? resultBadge(first.last_result) : resultBadge(null)}</span>
        </div>
        ${first && ['error','not_found','found_not_open_yet'].includes(first.last_result) && first.last_error_message
          ? `<div class="sel-error-box" id="sel-error-box"><span class="err-label">${first.last_result === 'found_not_open_yet' ? 'Last Info' : first.last_result === 'not_found' ? 'Not Found' : 'Last Error'}</span>${esc(first.last_error_message)}</div>`
          : `<div class="sel-error-box" id="sel-error-box" style="display:none"><span class="err-label">Last Error</span><span id="sel-error-text"></span></div>`
        }
      </div>
    </div>

    <!-- Saved Jobs — desktop table (hidden on mobile) -->
    <div class="card desktop-table-card">
      <div class="card-header"><h2>Saved Jobs</h2></div>
      <div class="table-scroll">
        <table class="jobs-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Class</th>
              <th>Day</th>
              <th>Time</th>
              <th>Date</th>
              <th>Instructor</th>
              <th>Phase</th>
              <th>Last Run</th>
              <th>Last Result</th>
              <th>Opens In</th>
            </tr>
          </thead>
          <tbody id="jobs-body">
            ${jobRowsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Saved Jobs — mobile cards (hidden on desktop) -->
    <div class="card mobile-jobs-card" data-tab-section="plan">
      <div class="card-header"><h2>Jobs</h2></div>
      <div id="mobile-jobs-list">${mobileJobCardsHtml}</div>
    </div>

    <!-- Actions -->
    <div class="card" data-tab-section="tools">
      <div class="card-header"><h2>Actions</h2></div>
      <div class="card-body actions">
        <div class="dry-run-row">
          <div class="dry-run-label">
            <strong>Dry Run Mode</strong>
            <small>When ON, bot navigates but never clicks Register/Waitlist</small>
          </div>
          <label class="switch">
            <input type="checkbox" id="dry-run-toggle" ${dryRunEnabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>

        <!-- Primary run actions (hidden on mobile — moved to sticky bottom bar) -->
        <button class="btn btn-primary mobile-hidden" id="btn-run" onclick="runSelected()">
          &#9654; Run Now (Direct)
        </button>
        <button class="btn btn-secondary mobile-hidden" id="btn-run-sched-sel" onclick="runSelectedScheduler()">
          &#9654; Run Selected (Scheduler Mode)
        </button>
        <button class="btn btn-secondary" id="btn-run-tick" onclick="runSchedulerOnce()">
          &#9654;&#9654; Run All (Scheduler Mode)
        </button>

        <!-- Secondary actions: visible on desktop, moved into More Actions on mobile -->
        <button class="btn btn-danger mobile-hidden" id="btn-force-run" onclick="forceRunSelected()">
          &#9888; Force Run (Ignore Rules)
        </button>
        <button class="btn btn-secondary mobile-hidden" id="btn-register" onclick="runRegister()">
          Run Default Job
        </button>
        <button class="btn btn-muted mobile-hidden" id="btn-clean" onclick="cleanTestJobs()">
          Clean Old Test Jobs
        </button>
        <button class="btn btn-toggle mobile-hidden ${first && !first.is_active ? '' : 'is-active'}" id="btn-toggle" onclick="toggleActive()">
          ${first ? (first.is_active ? 'Deactivate Job' : 'Activate Job') : 'Toggle Active'}
        </button>
        <button class="btn btn-danger mobile-hidden" id="btn-delete" onclick="deleteSelectedJob()">
          Delete Job
        </button>
        <button class="btn btn-muted mobile-hidden" id="btn-pause" onclick="pauseScheduler()">
          &#9646;&#9646; Pause Scheduler
        </button>
        <button class="btn btn-muted mobile-hidden" id="btn-resume" onclick="resumeScheduler()" style="display:none">
          &#9654; Resume Scheduler
        </button>

        <!-- More Actions button — mobile only -->
        <button class="btn btn-muted mobile-more-btn" onclick="openMoreActions()">
          &#183;&#183;&#183; More Actions
        </button>
      </div>
    </div>

    <!-- Create Job -->
    <div class="card" data-tab-section="plan">
      <div class="card-header"><h2>Create Job</h2></div>
      <div class="card-body">
        ${error ? `<div class="form-error">&#9888; ${esc(error)}</div>` : ''}
        <form method="POST" action="/add-job">
          <div class="form-grid">
            <div class="form-field">
              <label>Title<span class="req">*</span></label>
              <input type="text" name="title" placeholder="Core Pilates" required>
            </div>
            <div class="form-field">
              <label>Instructor<span class="req">*</span></label>
              <input type="text" name="instructor" placeholder="Stephanie Sanders" required>
            </div>
            <div class="form-field">
              <label>Day<span class="req">*</span></label>
              <select name="day" required>
                <option value="">— select —</option>
                <option>Sunday</option>
                <option>Monday</option>
                <option>Tuesday</option>
                <option selected>Wednesday</option>
                <option>Thursday</option>
                <option>Friday</option>
                <option>Saturday</option>
              </select>
            </div>
            <div class="form-field">
              <label>Time<span class="req">*</span></label>
              <input type="text" name="time" placeholder="7:45 AM" required>
            </div>
            <div class="form-field full-width">
              <label>Target Date <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></label>
              <input type="date" name="target_date">
            </div>
          </div>
          <button type="submit" class="btn btn-create" style="margin-top:18px;width:100%;">
            Save Job
          </button>
        </form>
      </div>
    </div>

    <!-- Edit Job -->
    <div class="card" data-tab-section="plan">
      <div class="card-header"><h2>Edit Selected Job</h2></div>
      <div class="card-body">
        ${editError ? `<div class="form-error">&#9888; ${esc(editError)}</div>` : ''}
        <form method="POST" action="/update-job" id="edit-form">
          <input type="hidden" name="job_id" id="edit-job-id" value="${first ? first.id : ''}">
          <div class="form-grid">
            <div class="form-field">
              <label>Title<span class="req">*</span></label>
              <input type="text" name="title" id="edit-title" placeholder="Core Pilates"
                     value="${first ? esc(first.class_title) : ''}" required>
            </div>
            <div class="form-field">
              <label>Instructor<span class="req">*</span></label>
              <input type="text" name="instructor" id="edit-instructor" placeholder="Stephanie Sanders"
                     value="${first ? esc(first.instructor || '') : ''}" required>
            </div>
            <div class="form-field">
              <label>Day<span class="req">*</span></label>
              <select name="day" id="edit-day" required>
                <option value="">— select —</option>
                ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d =>
                  `<option${first && first.day_of_week === d ? ' selected' : ''}>${d}</option>`
                ).join('')}
              </select>
            </div>
            <div class="form-field">
              <label>Time<span class="req">*</span></label>
              <input type="text" name="time" id="edit-time" placeholder="7:45 AM"
                     value="${first ? esc(first.class_time || '') : ''}" required>
            </div>
            <div class="form-field full-width">
              <label>Target Date <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></label>
              <input type="date" name="target_date" id="edit-target-date"
                     value="${first && first.target_date ? esc(first.target_date) : ''}">
            </div>
          </div>
          <button type="submit" class="btn btn-create" style="margin-top:18px;width:100%;">
            Save Changes
          </button>
        </form>
      </div>
    </div>

    <!-- Status — legacy, hidden on mobile, kept for desktop and JS targets -->
    <div class="card now-status-legacy">
      <div class="card-header"><h2>Status</h2></div>
      <div class="card-body status-body">
        <div id="status">Ready to run ${first ? 'Job #' + first.id : 'a job'}.</div>
        <div class="last-run" id="last-run" style="display:none"></div>
      </div>
    </div>

    <div class="card" data-tab-section="tools">
      <div class="card-header"><h2>Failure Summary</h2></div>
      <div class="card-body">
        <div id="failure-summary"><span id="failure-summary-empty">No failures recorded.</span></div>
      </div>
    </div>

    <div class="card" data-tab-section="tools">
      <div class="card-header"><h2>Recent Failures</h2></div>
      <div class="card-body">
        <div id="failure-list"><span id="failure-list-empty">No failures recorded.</span></div>
      </div>
    </div>

  </div><!-- /page -->
  </div><!-- /main-container -->

  <!-- Sticky bottom run bar (mobile only — fixed position, outside scroll container) -->
  <div id="sticky-run-bar">
    <button class="srb-primary" onclick="runSelectedScheduler(this)">&#9654; Run Selected (Scheduler Mode)</button>
    <button class="srb-secondary" onclick="runSelected(this)">Run Now (Direct)</button>
  </div>

  <!-- Trace viewer modal — populated by openTrace() -->
  <div id="trace-viewer" class="trace-modal hidden">
    <div class="trace-content">
      <img id="trace-image" alt="Failure screenshot">
      <div id="trace-details"></div>
      <span class="trace-close" id="trace-close">Tap anywhere to close</span>
    </div>
  </div>

  <script>
    // ---- state ----
    let selectedJobId         = ${first ? first.id : 'null'};
    let selectedJobLabel      = ${JSON.stringify(firstLabel)};
    let selectedJobPhase      = ${JSON.stringify(firstPhase)};
    let selectedJobLastRunAt  = ${JSON.stringify(first ? (first.last_run_at  || '') : '')};
    let selectedJobLastResult = ${JSON.stringify(first ? (first.last_result  || '') : '')};
    let selectedJobTargetDate = ${JSON.stringify(first ? (first.target_date  || '') : '')};
    let selectedJobIsActive      = ${first ? (first.is_active ? 'true' : 'false') : 'true'};
    let selectedJobLastSuccessAt = ${JSON.stringify(first ? (first.last_success_at || '') : '')};
    let selectedJobLastErrMsg    = ${JSON.stringify(first && ['error','not_found','found_not_open_yet'].includes(first.last_result) ? (first.last_error_message || '') : '')};
    let selectedJobBookingOpen   = ${firstBookingOpenMs || 'null'};
    let activeBtn             = null;
    let activeSuccessText     = null;
    let activeBtnOriginalLabel = null;
    let dotsTimer             = null;

    const PHASE_LABEL = ${JSON.stringify(PHASE_LABEL)};

    // ---- display helpers (mirror server-side versions) ----
    function fmtRunAt(iso) {
      if (!iso) return 'Never';
      try {
        return new Date(iso).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
        });
      } catch(e) { return iso; }
    }
    function resultBadge(r) {
      if (!r) return '<span class="badge badge-result-none">\u2014</span>';
      return '<span class="badge badge-result-' + r + '">' + r + '</span>';
    }

    // Returns true if the job represented by current selectedJob* state should
    // show the "Booked" badge.  Mirrors the scheduler's already-booked guard.
    function isBooked() {
      if (!selectedJobLastSuccessAt) return false;
      if (selectedJobTargetDate) {
        return selectedJobLastSuccessAt.startsWith(selectedJobTargetDate);
      }
      // Week-based fallback.
      const successDate  = new Date(selectedJobLastSuccessAt);
      const now          = new Date();
      const daysSinceMon = (now.getUTCDay() + 6) % 7;
      const weekStart    = new Date(now);
      weekStart.setUTCHours(0, 0, 0, 0);
      weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon);
      return successDate >= weekStart;
    }

    // Formats ms-until-open as H:MM:SS countdown string, or returns null when
    // the booking window is already open (diff <= 0) or unknown (null).
    function formatCountdown(bookingOpenMs) {
      if (!bookingOpenMs) return null;
      const diff = bookingOpenMs - Date.now();
      if (diff <= 0) return null;                  // open — caller shows 🔥 OPEN
      const totalSec = Math.ceil(diff / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
    }

    // Builds the .digit span structure for a countdown string from scratch.
    function initCountdownDigits(el, text) {
      el.innerHTML = '';
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (ch === ':') {
          var sep = document.createElement('span');
          sep.textContent = ':';
          el.appendChild(sep);
        } else {
          var d = document.createElement('span');
          d.className = 'digit';
          var inner = document.createElement('span');
          inner.className = 'digit-inner';
          inner.textContent = ch;
          d.appendChild(inner);
          el.appendChild(d);
        }
      }
    }

    // Slides a single .digit span to its new value; no-op if unchanged.
    function animateDigit(el, newVal) {
      var inner = el.querySelector('.digit-inner');
      if (!inner || inner.textContent === newVal) return;
      var next = document.createElement('span');
      next.className = 'digit-inner';
      next.textContent = newVal;
      el.appendChild(next);
      requestAnimationFrame(function() { el.classList.add('roll-up'); });
      setTimeout(function() {
        el.classList.remove('roll-up');
        el.innerHTML = '<span class="digit-inner">' + newVal + '</span>';
      }, 180);
    }

    // Animates only the digits that changed; rebuilds if format length changed.
    function updateCountdownDigits(el, newText) {
      var digitEls  = el.querySelectorAll('.digit');
      var newDigits = newText.replace(/:/g, '').split('');
      if (digitEls.length !== newDigits.length) {
        initCountdownDigits(el, newText);
        return;
      }
      for (var i = 0; i < newDigits.length; i++) {
        animateDigit(digitEls[i], newDigits[i]);
      }
    }

    // Applies countdown text + warning class to a single element.
    // el: DOM element.  bookingOpenMs: epoch ms for when booking opens.
    function applyCountdown(el, bookingOpenMs) {
      if (!bookingOpenMs) {
        el.innerHTML = '';
        el.textContent = '';
        el.classList.remove('countdown-warning');
        return;
      }
      const diff      = bookingOpenMs - Date.now();
      const isWarning = diff > 0 && diff <= 60000;
      if (diff <= 0) {
        if (el.querySelector('.digit')) el.innerHTML = '';
        el.textContent = '\uD83D\uDD25 OPEN';
        el.classList.remove('countdown-warning');
      } else {
        const label = formatCountdown(bookingOpenMs);
        el.classList.toggle('countdown-warning', isWarning);
        if (!el.querySelector('.digit')) {
          initCountdownDigits(el, label);
        } else {
          updateCountdownDigits(el, label);
        }
      }
    }

    // Returns true if a table row's job is already booked (mirrors isBooked() but
    // reads directly from data attributes so it works for any row, not just the
    // currently selected one).
    function isRowBooked(row) {
      const sat = row.dataset.lastSuccessAt || '';
      if (!sat) return false;
      const td  = row.dataset.targetDate || '';
      if (td)  return sat.startsWith(td);
      const successDate  = new Date(sat);
      const now          = new Date();
      const daysSinceMon = (now.getUTCDay() + 6) % 7;
      const weekStart    = new Date(now);
      weekStart.setUTCHours(0, 0, 0, 0);
      weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon);
      return successDate >= weekStart;
    }

    // Shows or hides the #sel-sniper indicator in the card.
    // Visible when: phase is "sniper" OR booking opens within 60 seconds.
    function updateSniperIndicator(bookingOpenMs, phase) {
      const el = document.getElementById('sel-sniper');
      if (!el) return;
      const diff = bookingOpenMs ? (bookingOpenMs - Date.now()) : Infinity;
      const show = phase === 'sniper' || (diff > 0 && diff <= 60000);
      el.style.display = show ? '' : 'none';
    }

    // Shows or hides the 📌 Pinned indicator based on userPinned.
    function updatePinIndicator() {
      const el = document.getElementById('sel-pin-box');
      if (el) el.style.display = userPinned ? '' : 'none';
    }

    // Clears the pin: re-enables auto-scroll and removes the localStorage key.
    function unpin() {
      userPinned = false;
      localStorage.removeItem('selectedJobId');
      updatePinIndicator();
    }

    // Guard so the alert sound only fires once per countdown cycle.
    let hasPlayed = false;
    // Set when the user actively pins a job; suppresses auto-scroll.
    let userPinned = false;

    // Tick every second: update countdown cells, highlight the next job to open,
    // trigger sound alert in final 10 s, and refresh the sniper indicator.
    // Aligned to wall-clock second boundaries so digits roll exactly at :00.
    function tick() {
      const now   = Date.now();
      const rows  = document.querySelectorAll('.job-row');
      let   nextRow    = null;   // unbooked active job with smallest future diff
      let   nextDiff   = Infinity;
      let   nextBoms   = null;   // absolute bookingOpenMs for nextRow (for formatCountdown)
      let   openNowRow = null;   // unbooked active job whose booking window is already open

      // Pass 1: update each row's countdown cell; find next-to-open unbooked job.
      rows.forEach(function(row) {
        const boms = row.dataset.bookingOpen ? Number(row.dataset.bookingOpen) : null;
        const cell = row.querySelector('.job-countdown');
        if (cell) applyCountdown(cell, boms);

        if (boms && !isRowBooked(row) && row.dataset.isActive === '1') {
          const diff = boms - now;
          if (diff > 0 && diff < nextDiff) {
            nextDiff = diff;
            nextBoms = boms;
            nextRow  = row;
          } else if (diff <= 0 && !openNowRow) {
            openNowRow = row;  // first already-open candidate
          }
        }
      });

      // Apply / remove the .next-job highlight.
      rows.forEach(function(r) { r.classList.remove('next-job'); });
      if (nextRow) nextRow.classList.add('next-job');

      // Update the global next-job banner.
      // Priority: future job (nextRow) > already-open job (openNowRow) > hide.
      const banner = document.getElementById('next-job-banner');
      if (banner) {
        const bannerRow = nextRow || openNowRow;
        if (!bannerRow) {
          banner.classList.add('hidden');
        } else {
          banner.classList.remove('hidden', 'warning', 'sniper');
          const bannerTitle = bannerRow.dataset.title || ('Job #' + bannerRow.dataset.id);
          var bnrSub, bnrState;
          if (!nextRow) {
            bnrSub   = 'Booking open now';
            bnrState = 'sniper';
          } else if (nextDiff <= 60000) {
            bnrSub   = 'Opens in ' + formatCountdown(nextBoms);
            bnrState = 'warning';
          } else {
            bnrSub   = 'Opens in ' + formatCountdown(nextBoms);
            bnrState = '';
          }
          banner.innerHTML =
            '<span class="bnr-dot"></span>' +
            '<span class="bnr-body">' +
              '<strong class="bnr-title">' + bannerTitle + '</strong>' +
              '<span class="bnr-sub">' + bnrSub + '</span>' +
            '</span>';
          if (bnrState) banner.classList.add(bnrState);
        }
      }

      // Auto-scroll to the next-to-open row only when the user hasn't pinned one.
      if (!userPinned && nextRow) {
        nextRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      // Sound alert: fire once when the next job enters its final 10 seconds.
      if (nextDiff > 0 && nextDiff <= 10000 && !hasPlayed) {
        hasPlayed = true;
        try {
          new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg').play()
            .catch(function() {});            // silently ignore autoplay block
        } catch(e) {}
      }
      if (nextDiff > 60000) hasPlayed = false; // reset for next cycle

      // Pass 2: update Selected Job card countdown + sniper indicator.
      const cardCd = document.getElementById('sel-countdown');
      if (cardCd) applyCountdown(cardCd, selectedJobBookingOpen);
      updateSniperIndicator(selectedJobBookingOpen, selectedJobPhase);
      syncTodayWidget();
      syncNowTab();
    }
    tick(); // initialize display immediately on load
    (function scheduleTick() {
      setTimeout(function() { tick(); scheduleTick(); }, 1000 - Date.now() % 1000);
    })();

    // On load: restore the previously selected job from localStorage, or fall
    // back to the first row.  Sets userPinned only when a saved choice is found.
    (function() {
      const savedId   = localStorage.getItem('selectedJobId');
      const allRows   = document.querySelectorAll('.job-row');
      let   target    = null;
      let   fromSaved = false;
      if (savedId) {
        allRows.forEach(r => { if (r.dataset.id === savedId) { target = r; fromSaved = true; } });
      }
      if (!target && allRows.length) target = allRows[0];
      if (target) selectJob(target);          // does NOT set userPinned by itself
      if (fromSaved) {                        // only pin when we actually restored
        userPinned = true;
        updatePinIndicator();
      }
    })();

    // ---- job selection ----
    // fromUser=true: called by a real click — sets pin.
    // fromUser=false (default): called programmatically (load, refresh) — no pin.
    function selectJob(row, fromUser) {
      if (fromUser) {
        userPinned = true;
        localStorage.setItem('selectedJobId', row.dataset.id);
        updatePinIndicator();
      }
      // Only reset status if no job is currently running.
      if (!activeBtn || !activeBtn.disabled) {
        stopDots();
        const statusEl = document.getElementById('status');
        statusEl.className   = '';
        statusEl.textContent = 'Ready to run Job #' + row.dataset.id + '.';
        const lastRunEl = document.getElementById('last-run');
        lastRunEl.style.display = 'none';
        lastRunEl.innerHTML = '';
      }

      document.querySelectorAll('.job-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      // Sync mobile card highlight
      document.querySelectorAll('.mobile-job-card').forEach(c =>
        c.classList.toggle('selected', c.dataset.id === String(row.dataset.id)));
      selectedJobId         = row.dataset.id;
      selectedJobPhase      = row.dataset.phase      || 'unknown';
      selectedJobLastRunAt  = row.dataset.lastRunAt  || '';
      selectedJobLastResult = row.dataset.lastResult || '';
      selectedJobTargetDate = row.dataset.targetDate || '';
      selectedJobIsActive      = row.dataset.isActive      === '1';
      selectedJobLastSuccessAt = row.dataset.lastSuccessAt  || '';
      selectedJobLastErrMsg    = row.dataset.lastErrorMsg   || '';
      selectedJobBookingOpen   = row.dataset.bookingOpen ? Number(row.dataset.bookingOpen) : null;
      selectedJobLabel = 'Job #' + row.dataset.id + ' \u2014 ' +
        [row.dataset.title, row.dataset.day, row.dataset.time, row.dataset.instructor]
          .filter(Boolean).join(' \u00b7 ');

      // Selected Job card
      document.getElementById('sel-id').textContent    = 'Job #' + row.dataset.id;
      document.getElementById('sel-title').textContent = row.dataset.title;
      document.getElementById('sel-meta').textContent  =
        [row.dataset.title, row.dataset.day, row.dataset.time, row.dataset.instructor]
          .filter(Boolean).join(' \u00b7 ');
      const ph = selectedJobPhase;
      document.getElementById('sel-phase').innerHTML      =
        '<span class="badge badge-phase-' + ph + '">' + (PHASE_LABEL[ph] || ph) + '</span>';
      document.getElementById('sel-date').innerHTML =
        'Date: <strong>' + (selectedJobTargetDate || '\u2014') + '</strong>';
      document.getElementById('sel-last-run').textContent = fmtRunAt(selectedJobLastRunAt);
      document.getElementById('sel-last-result').innerHTML = resultBadge(selectedJobLastResult);

      // Refresh card countdown + sniper indicator immediately on selection.
      const cdEl = document.getElementById('sel-countdown');
      if (cdEl) applyCountdown(cdEl, selectedJobBookingOpen);
      updateSniperIndicator(selectedJobBookingOpen, selectedJobPhase);

      // Show or hide the "Booked" badge.
      const bookedBox  = document.getElementById('sel-booked-box');
      const bookedText = document.getElementById('sel-booked-text');
      if (bookedBox) {
        if (isBooked()) {
          const label = selectedJobTargetDate
            ? 'Booked for ' + selectedJobTargetDate
            : 'Booked this week';
          if (bookedText) bookedText.textContent = label;
          bookedBox.style.display = '';
        } else {
          bookedBox.style.display = 'none';
        }
      }

      // Show or hide the message box for non-success statuses
      const errBox = document.getElementById('sel-error-box');
      if (errBox) {
        const MSG_STATUSES = ['error', 'not_found', 'found_not_open_yet'];
        if (MSG_STATUSES.includes(selectedJobLastResult) && selectedJobLastErrMsg) {
          const label = selectedJobLastResult === 'found_not_open_yet' ? 'Last Info'
                      : selectedJobLastResult === 'not_found'          ? 'Not Found'
                      : 'Last Error';
          const labelEl = errBox.querySelector('.err-label');
          if (labelEl) labelEl.textContent = label;
          const errText = document.getElementById('sel-error-text');
          if (errText) errText.textContent = selectedJobLastErrMsg;
          else errBox.lastChild.textContent = selectedJobLastErrMsg;
          errBox.style.display = '';
        } else {
          errBox.style.display = 'none';
        }
      }

      // Populate the Edit Job form with values from this row
      document.getElementById('edit-job-id').value     = row.dataset.id;
      document.getElementById('edit-title').value      = row.dataset.title       || '';
      document.getElementById('edit-instructor').value = row.dataset.instructor  || '';
      document.getElementById('edit-time').value       = row.dataset.time        || '';
      document.getElementById('edit-target-date').value = row.dataset.targetDate || '';
      const daySelect = document.getElementById('edit-day');
      for (let i = 0; i < daySelect.options.length; i++) {
        daySelect.options[i].selected = daySelect.options[i].text === row.dataset.day;
      }

      // Update Toggle Active button label + style (main actions + More Actions panel)
      const toggleBtn  = document.getElementById('btn-toggle');
      const maToggle   = document.getElementById('ma-toggle');
      const toggleText = selectedJobIsActive ? 'Deactivate Job' : 'Activate Job';
      if (toggleBtn) {
        toggleBtn.textContent = toggleText;
        toggleBtn.classList.toggle('is-active', selectedJobIsActive);
      }
      if (maToggle) {
        maToggle.textContent = toggleText;
        maToggle.classList.toggle('is-active', selectedJobIsActive);
      }
      syncTodayWidget();
      syncNowTab();
    }

    // ---- animated dots ----
    function startDots(statusEl, baseText) {
      stopDots();
      let count = 0;
      const steps = ['.', '..', '...', '..'];
      statusEl.className   = 'running';
      statusEl.textContent = baseText + '.';
      dotsTimer = setInterval(function() {
        count = (count + 1) % steps.length;
        statusEl.textContent = baseText + steps[count];
      }, 500);
    }
    function stopDots() {
      if (dotsTimer) { clearInterval(dotsTimer); dotsTimer = null; }
    }

    // ---- last run display ----
    function showLastRun(success, text) {
      const el = document.getElementById('last-run');
      const ts = new Date().toLocaleTimeString();
      const icon = success ? '\u2705' : '\u274c';
      el.innerHTML = '<strong>Last run:</strong> ' + icon + ' ' + ts + ' \u2014 ' + text;
      el.style.display = '';
    }

    // ---- lock / unlock Run Selected Job button across all runs ----
    function lockRunBtn()   {
      const b = document.getElementById('btn-run');
      if (b) b.disabled = true;
    }
    function unlockRunBtn() {
      const b = document.getElementById('btn-run');
      if (b && b !== activeBtn) b.disabled = false;
    }

    // ---- shared job runner ----
    async function startJob(url, btn, successText, jobLabel) {
      const statusEl = document.getElementById('status');
      activeBtnOriginalLabel = btn.textContent.trim();
      btn.disabled   = true;
      btn.textContent = 'Running\u2026';
      lockRunBtn();
      activeBtn         = btn;
      activeSuccessText = successText;
      startDots(statusEl, 'Running ' + (jobLabel || 'job'));
      try {
        const res  = await fetch(url);
        const data = await res.json();
        if (!data.started) {
          stopDots();
          if (data.log && data.log.includes('Already running')) {
            startDots(statusEl, 'Job already in progress');
            poll(jobLabel);
          } else {
            statusEl.className   = 'error';
            statusEl.textContent = data.log || 'Could not start job.';
            btn.textContent = activeBtnOriginalLabel;
            btn.disabled    = false;
            unlockRunBtn();
          }
          return;
        }
        poll(jobLabel);
      } catch (e) {
        stopDots();
        statusEl.className   = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
        btn.textContent = activeBtnOriginalLabel;
        btn.disabled    = false;
        unlockRunBtn();
      }
    }

    async function poll(jobLabel) {
      const statusEl = document.getElementById('status');
      try {
        const res  = await fetch('/status');
        const data = await res.json();
        if (data.active) {
          startDots(statusEl, 'Running ' + (jobLabel || 'job'));
          setTimeout(function() { poll(jobLabel); }, 2000);
        } else {
          stopDots();
          const prefix = jobLabel ? jobLabel + ' \u2014 ' : '';
          statusEl.className = data.success ? 'success' : 'error';
          if (data.success) {
            triggerUnifiedSuccess();
            updateStatusSmooth(statusEl, prefix + data.log);
          } else {
            statusEl.textContent = prefix + data.log;
          }
          showLastRun(data.success, data.log);
          if (activeBtn) {
            activeBtn.textContent = data.success ? activeSuccessText : activeBtnOriginalLabel;
            if (!data.success) activeBtn.disabled = false;
          }
          unlockRunBtn();
        }
      } catch (e) {
        startDots(statusEl, 'Checking status');
        setTimeout(function() { poll(jobLabel); }, 3000);
      }
    }

    function runSelected(overrideBtn) {
      if (!selectedJobId) {
        const statusEl = document.getElementById('status');
        statusEl.className   = 'error';
        statusEl.textContent = 'No job selected. Click a row in the Saved Jobs table first.';
        return;
      }
      startJob(
        '/run-job?id=' + selectedJobId,
        overrideBtn || document.getElementById('btn-run'),
        '\u2705 Done!',
        selectedJobLabel
      );
    }

    function runRegister() {
      startJob(
        '/register',
        document.getElementById('btn-register'),
        '\u2705 Registered!',
        'Default job (Core Pilates)'
      );
    }

    async function toggleActive() {
      if (!selectedJobId) return;
      const btn = document.getElementById('btn-toggle');
      btn.disabled = true;
      try {
        const body = 'job_id=' + encodeURIComponent(selectedJobId) +
                     '&is_active=' + (selectedJobIsActive ? '0' : '1');
        const res = await fetch('/toggle-active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (res.ok) window.location.reload();
      } catch (e) {
        btn.disabled = false;
      }
    }

    async function deleteSelectedJob() {
      if (!selectedJobId) return;
      if (!confirm('Delete Job #' + selectedJobId + '? This cannot be undone.')) return;
      const btn = document.getElementById('btn-delete');
      btn.disabled = true;
      try {
        const body = 'job_id=' + encodeURIComponent(selectedJobId);
        const res = await fetch('/delete-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (res.ok) window.location.reload();
      } catch (e) {
        btn.disabled = false;
      }
    }

    async function cleanTestJobs() {
      const btn = document.getElementById('btn-clean');
      const statusEl = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Cleaning\u2026';
      startDots(statusEl, 'Cleaning old test jobs');
      try {
        const res  = await fetch('/clean-test-jobs');
        const data = await res.json();
        stopDots();
        statusEl.textContent = data.log;
        statusEl.className   = data.success ? 'success' : 'error';
      } catch (e) {
        stopDots();
        statusEl.className   = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
      } finally {
        btn.textContent = 'Clean Old Test Jobs';
        btn.disabled    = false;
      }
    }

    // ---- force run (bypasses all scheduler rules) ----

    async function forceRunSelected() {
      if (!selectedJobId) return;
      if (!confirm('Force run ignores phase, cooldown, and booking status. Job #' + selectedJobId + ' will attempt to register immediately. Continue?')) return;
      const btn      = document.getElementById('btn-force-run');
      const statusEl = document.getElementById('status');
      btn.disabled    = true;
      btn.textContent = 'Force running\u2026';
      stopDots();
      startDots(statusEl, '\u26a0 Force running Job #' + selectedJobId);
      try {
        const res  = await fetch('/force-run-job?id=' + selectedJobId, { method: 'POST' });
        const data = await res.json();
        stopDots();
        statusEl.className = data.success ? 'success' : 'error';
        if (data.success) {
          triggerUnifiedSuccess();
          updateStatusSmooth(statusEl, data.message || 'Force run complete.');
        } else {
          statusEl.textContent = data.message || 'Force run complete.';
        }
      } catch (e) {
        stopDots();
        statusEl.className   = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
      } finally {
        btn.textContent = '\u26a0 Force Run (Ignore Rules)';
        btn.disabled    = false;
      }
    }

    // ---- manual scheduler tick (selected job only) ----

    async function runSelectedScheduler(overrideBtn) {
      if (!selectedJobId) return;
      const btn      = overrideBtn || document.getElementById('btn-run-sched-sel');
      const statusEl = document.getElementById('status');
      btn.disabled    = true;
      btn.textContent = 'Running\u2026';
      stopDots();
      startDots(statusEl, 'Running scheduler mode for Job #' + selectedJobId);
      try {
        const res  = await fetch('/run-selected-scheduler?id=' + selectedJobId, { method: 'POST' });
        const data = await res.json();
        stopDots();
        statusEl.textContent = data.message || 'Done.';
        statusEl.className   = data.success ? 'success' : 'error';
      } catch (e) {
        stopDots();
        statusEl.className   = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
      } finally {
        btn.textContent = '\u25BA Run Selected (Scheduler Mode)';
        btn.disabled    = false;
      }
    }

    // ---- manual scheduler tick (all jobs) ----

    async function runSchedulerOnce() {
      const btn      = document.getElementById('btn-run-tick');
      const statusEl = document.getElementById('status');
      btn.disabled    = true;
      btn.textContent = 'Running\u2026';
      stopDots();
      startDots(statusEl, 'Running scheduler tick');
      try {
        const res  = await fetch('/run-scheduler-once', { method: 'POST' });
        const data = await res.json();
        stopDots();
        statusEl.textContent = data.message || 'Scheduler tick complete.';
        statusEl.className   = data.success ? 'success' : 'error';
      } catch (e) {
        stopDots();
        statusEl.className   = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
      } finally {
        btn.textContent = '\u25BA\u25BA Run Scheduler Now';
        btn.disabled    = false;
      }
    }

    // ---- scheduler pause / resume ----

    function updateSchedulerUI(paused) {
      const statusEl = document.getElementById('scheduler-status');
      const pauseBtn = document.getElementById('btn-pause');
      const resumeBtn = document.getElementById('btn-resume');
      const maPause  = document.getElementById('ma-pause');
      const maResume = document.getElementById('ma-resume');
      if (statusEl) {
        statusEl.textContent = paused ? '\u23F8 Scheduler paused' : '\u25BA Scheduler running';
        statusEl.className   = paused ? 'scheduler-status paused' : 'scheduler-status';
      }
      if (pauseBtn)  pauseBtn.style.display  = paused ? 'none' : '';
      if (resumeBtn) resumeBtn.style.display = paused ? ''     : 'none';
      if (maPause)   maPause.style.display   = paused ? 'none' : '';
      if (maResume)  maResume.style.display  = paused ? ''     : 'none';
      localStorage.setItem('schedulerPaused', paused ? 'true' : 'false');
      const stgPause = document.getElementById('stg-pause');
      if (stgPause) stgPause.checked = paused;
      const stgSchedStatus = document.getElementById('stg-sched-status');
      if (stgSchedStatus) stgSchedStatus.textContent = paused ? '\u23F8 Scheduler paused' : '\u25BA Scheduler running';
      syncNowTab();
    }

    /* ---- More Actions bottom sheet ---- */
    function openMoreActions() {
      document.getElementById('moa-backdrop').classList.add('open');
      document.getElementById('moa-panel').classList.add('open');
    }
    function closeMoreActions() {
      document.getElementById('moa-backdrop').classList.remove('open');
      document.getElementById('moa-panel').classList.remove('open');
    }

    /* ---- Settings bottom sheet ---- */
    function openSettings() {
      document.getElementById('stg-backdrop').classList.add('open');
      document.getElementById('stg-panel').classList.add('open');
    }
    function closeSettings() {
      document.getElementById('stg-backdrop').classList.remove('open');
      document.getElementById('stg-panel').classList.remove('open');
    }

    /* ---- Mobile job card selection ---- */
    function selectMobileCard(card) {
      // Route through the matching table row so all existing selectJob() logic runs
      const row = document.querySelector('.job-row[data-id="' + card.dataset.id + '"]');
      if (row) {
        selectJob(row, true);
      } else {
        // No table row found (desktop table hidden) — call selectJob with the card directly
        selectJob(card, true);
      }
      // Sync mobile card highlight
      document.querySelectorAll('.mobile-job-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    }

    async function pauseScheduler() {
      try {
        await fetch('/pause-scheduler', { method: 'POST' });
        updateSchedulerUI(true);
      } catch (e) {
        console.error('Failed to pause scheduler:', e.message);
      }
    }

    async function resumeScheduler() {
      try {
        await fetch('/resume-scheduler', { method: 'POST' });
        updateSchedulerUI(false);
      } catch (e) {
        console.error('Failed to resume scheduler:', e.message);
      }
    }

    // On load: restore pause state from localStorage and sync with server.
    (function() {
      const wasPaused = localStorage.getItem('schedulerPaused') === 'true';
      if (wasPaused) {
        fetch('/pause-scheduler', { method: 'POST' }).catch(function() {});
        updateSchedulerUI(true);
      } else {
        updateSchedulerUI(false);
      }
    })();

    // ---- smooth status text update (success path only) ----

    function updateStatusSmooth(el, text) {
      el.classList.add('status-fade-out');
      setTimeout(function() {
        el.textContent = text;
        el.classList.remove('status-fade-out'); // transition back to opacity:1
      }, 120);
    }

    // ---- unified success feedback ----

    function triggerFlash() {
      var flash = document.getElementById('haptic-flash');
      flash.classList.remove('haptic-active');
      void flash.offsetWidth;
      flash.classList.add('haptic-active');
    }

    function triggerBounce() {
      var card = document.querySelector('.selected-job-card');
      if (!card) return;
      card.classList.remove('haptic-bounce');
      void card.offsetWidth;
      card.classList.add('haptic-bounce');
    }

    function triggerCheckmark() {
      var el = document.getElementById('success-checkmark');
      el.classList.remove('checkmark-show');
      void el.offsetWidth;
      el.classList.add('checkmark-show');
    }

    var _sspTimer = null;
    function triggerSuccessPulse() {
      var el = document.getElementById('sel-success-pulse');
      if (!el) return;
      clearTimeout(_sspTimer);              /* cancel any in-flight cleanup */
      el.classList.remove('active', 'visible');
      void el.offsetWidth;                 /* force reflow so animation replays */
      el.classList.add('visible', 'active');
      _sspTimer = setTimeout(function() {
        el.classList.remove('active', 'visible'); /* restore display:none after animation */
      }, 1150);
    }

    var hapticEnabled = true;

    function triggerUnifiedSuccess() {
      if (hapticEnabled && navigator.vibrate) navigator.vibrate(10);
      requestAnimationFrame(function() {
        if (hapticEnabled) {
          triggerFlash();
          triggerBounce();
          triggerCheckmark();
        }
        triggerSuccessPulse();
      });
    }

    // ---- Today widget sync ----

    function syncTodayWidget() {
      var twLabel = document.getElementById('tw-label');
      var twTitle = document.getElementById('tw-title');
      var twMeta  = document.getElementById('tw-meta');
      var twPill  = document.getElementById('tw-pill');
      var twBadge = document.getElementById('tw-mode-badge');
      if (!twTitle) return;

      // Title
      var selTitle = document.getElementById('sel-title');
      var titleText = selTitle ? selTitle.textContent.trim() : '';
      twTitle.textContent = titleText || '\u2014';

      // Meta: sel-meta starts with "Title · Day · Time · Instructor"
      // Strip the leading "Title · " so we show "Day · Time · Instructor"
      var selMeta = document.getElementById('sel-meta');
      var metaText = selMeta ? selMeta.textContent.trim() : '';
      if (titleText && metaText.startsWith(titleText)) {
        metaText = metaText.slice(titleText.length).replace(/^\s*\u00b7\s*/, '');
      }
      twMeta.textContent = metaText;

      // Pill + label: booked > sniper > countdown
      var bookedBox  = document.getElementById('sel-booked-box');
      var sniperEl   = document.getElementById('sel-sniper');
      var cdEl       = document.getElementById('sel-countdown');
      var isBooked   = bookedBox && bookedBox.style.display !== 'none';
      var isSniper   = sniperEl  && sniperEl.style.display  !== 'none';
      var cdText     = cdEl ? cdEl.textContent.trim() : '';

      if (isBooked) {
        var bookedTextEl = document.getElementById('sel-booked-text');
        twPill.textContent = bookedTextEl ? bookedTextEl.textContent.trim() : 'Booked';
        twPill.className   = 'tw-pill booked';
        if (twLabel) twLabel.textContent = 'BOOKED';
      } else if (isSniper) {
        twPill.textContent = 'Opening now';
        twPill.className   = 'tw-pill opening';
        if (twLabel) twLabel.textContent = 'OPENING NOW';
      } else {
        twPill.textContent = cdText || '\u2014';
        twPill.className   = 'tw-pill';
        if (twLabel) twLabel.textContent = 'NEXT CLASS';
      }

      // Mode badge: text reflects current dry-run state; CSS hides it when Live
      if (twBadge) {
        twBadge.textContent = document.body.classList.contains('live-mode') ? '' : 'Dry Run';
      }
    }

    // ---- Now tab sync ----

    function setNpsStep(el, state) {
      if (!el) return;
      el.className = 'nps-step nps-' + state;
      var icon = el.querySelector('.nps-icon');
      if (icon) {
        icon.textContent = state === 'done' ? '\u2713' : state === 'current' ? '\u25cf' : state === 'error' ? '\u00d7' : '\u25cb';
      }
    }

    function syncNowTab() {
      var nhcDot    = document.getElementById('nhc-dot');
      if (!nhcDot) return;

      var phase      = selectedJobPhase;
      var lastResult = selectedJobLastResult;
      var isBooked   = (lastResult === 'booked');
      var isSniper   = (phase === 'sniper');

      var schedStatusEl = document.getElementById('scheduler-status');
      var isPaused = schedStatusEl && schedStatusEl.classList.contains('paused');
      var isLive   = document.body.classList.contains('live-mode');

      // --- Class name
      var selTitle = document.getElementById('sel-title');
      var titleText = selTitle ? selTitle.textContent.trim() : '';
      var nhcClassName = document.getElementById('nhc-class-name');
      if (nhcClassName) nhcClassName.textContent = titleText || '\u2014';

      // --- Class meta: "Tuesday \u00b7 4:20 PM \u00b7 Gretl" \u2192 "Tuesday at 4:20 PM with Gretl"
      var selMeta = document.getElementById('sel-meta');
      var metaText = selMeta ? selMeta.textContent.trim() : '';
      if (titleText && metaText.startsWith(titleText)) {
        metaText = metaText.slice(titleText.length).replace(/^\s*\u00b7\s*/, '');
      }
      var parts = metaText.split('\u00b7').map(function(s) { return s.trim(); }).filter(Boolean);
      var formattedMeta = parts.length >= 2
        ? parts[0] + ' at ' + parts[1] + (parts[2] ? ' with ' + parts[2] : '')
        : metaText;
      var nhcClassMeta = document.getElementById('nhc-class-meta');
      if (nhcClassMeta) nhcClassMeta.textContent = formattedMeta;

      // --- State label + dot
      var nhcState   = document.getElementById('nhc-state');
      var stateStr, dotCls;
      if (isBooked) {
        stateStr = 'Booked'; dotCls = 'dot-green';
      } else if (isSniper) {
        stateStr = 'Booking now'; dotCls = 'dot-amber';
      } else if (isPaused) {
        stateStr = 'Paused'; dotCls = 'dot-gray';
      } else if (phase === 'warmup') {
        stateStr = 'Opening soon'; dotCls = 'dot-amber';
      } else if (phase === 'late' && lastResult !== 'booked') {
        stateStr = 'Window passed'; dotCls = 'dot-gray';
      } else {
        stateStr = 'Monitoring'; dotCls = 'dot-green';
      }
      nhcDot.className = 'nhc-state-dot ' + dotCls;
      if (nhcState) nhcState.textContent = stateStr;

      // --- Mode pill
      var nhcModePill = document.getElementById('nhc-mode-pill');
      if (nhcModePill) nhcModePill.style.display = isLive ? 'none' : '';

      // --- Countdown block
      var cdEl     = document.getElementById('sel-countdown');
      var cdText   = cdEl ? cdEl.textContent.trim() : '';
      var nhcCdLabel = document.getElementById('nhc-countdown-label');
      var nhcCd      = document.getElementById('nhc-countdown');
      var nhcSub     = document.getElementById('nhc-sub-text');
      var bookedTextEl = document.getElementById('sel-booked-text');

      if (isBooked) {
        if (nhcCdLabel) nhcCdLabel.style.display = 'none';
        if (nhcCd) { nhcCd.textContent = bookedTextEl ? bookedTextEl.textContent.trim() : 'Booked'; nhcCd.className = 'nhc-countdown nhc-cd-booked'; }
        if (nhcSub) nhcSub.textContent = 'Booking confirmed. See you there!';
      } else if (isSniper) {
        if (nhcCdLabel) { nhcCdLabel.style.display = ''; nhcCdLabel.textContent = 'Registration opening'; }
        if (nhcCd) { nhcCd.textContent = 'Now'; nhcCd.className = 'nhc-countdown nhc-cd-now'; }
        if (nhcSub) nhcSub.textContent = 'Attempting to book right now\u2026';
      } else {
        if (nhcCdLabel) { nhcCdLabel.style.display = ''; nhcCdLabel.textContent = 'Next action in'; }
        if (nhcCd) { nhcCd.textContent = cdText || '\u2014'; nhcCd.className = 'nhc-countdown'; }
        if (nhcSub) nhcSub.textContent = isPaused
          ? 'Booking is paused. Tap Resume to re-enable automatic monitoring.'
          : 'Will automatically attempt booking when registration opens';
      }

      // --- App header sub-text
      var mahStatus = document.getElementById('mah-status');
      if (mahStatus) {
        if (isPaused)    mahStatus.textContent = 'Booking paused';
        else if (isBooked)  mahStatus.textContent = 'Booking confirmed';
        else if (isSniper)  mahStatus.textContent = 'Booking now\u2026';
        else mahStatus.textContent = isLive ? 'Active and monitoring' : 'Dry Run \u00b7 Active';
      }

      // --- Progress steps
      var s0 = document.getElementById('nps-0');
      var s1 = document.getElementById('nps-1');
      var s2 = document.getElementById('nps-2');
      var s0St, s1St, s2St;
      if (isBooked || lastResult === 'booked') {
        s0St = 'done'; s1St = 'done'; s2St = 'done';
      } else if (isSniper) {
        s0St = 'done'; s1St = 'done'; s2St = 'current';
      } else if (phase === 'warmup') {
        s0St = 'done'; s1St = 'current'; s2St = 'upcoming';
      } else if (lastResult === 'found_not_open_yet') {
        s0St = 'done'; s1St = 'current'; s2St = 'upcoming';
      } else if (lastResult === 'not_found') {
        s0St = 'current'; s1St = 'upcoming'; s2St = 'upcoming';
      } else if (lastResult === 'error') {
        s0St = 'done'; s1St = 'error'; s2St = 'upcoming';
      } else {
        s0St = 'current'; s1St = 'upcoming'; s2St = 'upcoming';
      }
      setNpsStep(s0, s0St);
      setNpsStep(s1, s1St);
      setNpsStep(s2, s2St);

      // --- Detail card
      var lastRunEl = document.getElementById('sel-last-run');
      var ndcLastChecked = document.getElementById('ndc-last-checked');
      if (ndcLastChecked && lastRunEl) ndcLastChecked.textContent = lastRunEl.textContent.trim();

      var ndcStatus = document.getElementById('ndc-status-val');
      if (ndcStatus) {
        var humanResult = {
          'found_not_open_yet': 'Registration not open yet',
          'booked':             'Booking confirmed',
          'error':              'An error occurred',
          'not_found':          'Class not on schedule',
          'skipped':            'Skipped this cycle',
          'dry_run':            'Dry run completed',
        }[lastResult] || (lastResult ? lastResult.replace(/_/g, ' ') : '\u2014');
        ndcStatus.textContent = humanResult;
      }

      // --- Action row: pause vs resume
      var narPause  = document.getElementById('nar-pause');
      var narResume = document.getElementById('nar-resume');
      if (narPause)  narPause.style.display  = isPaused ? 'none' : '';
      if (narResume) narResume.style.display = isPaused ? ''     : 'none';
    }

    function deactivateSelectedJob() {
      if (selectedJobIsActive) toggleActive();
    }

    // ---- dry run toggle ----

    function updateDryRunUI(enabled) {
      const ind  = document.getElementById('dry-run-indicator');
      const live = document.getElementById('live-mode-indicator');
      ind.textContent  = enabled ? '\\u{1F9EA} Dry Run' : '\\u{1F680} Live';
      ind.className    = enabled ? 'mode-dry' : 'mode-live';
      document.body.classList.toggle('live-mode', !enabled);
      live.classList.toggle('visible', !enabled);
      const mahStatus = document.getElementById('mah-status');
      if (mahStatus) mahStatus.textContent = enabled ? 'Dry Run Mode' : 'Live Mode';
      const stgDry = document.getElementById('stg-dry-run');
      if (stgDry) stgDry.checked = enabled;
      const mainDryToggle = document.getElementById('dry-run-toggle');
      if (mainDryToggle) mainDryToggle.checked = enabled;
      const stgModeStatus = document.getElementById('stg-mode-status');
      if (stgModeStatus) stgModeStatus.textContent = enabled ? 'Dry Run Mode' : 'Live Mode';
      syncTodayWidget();
      syncNowTab();
    }

    // Apply initial live-mode state from server-rendered flag (no flicker on load).
    updateDryRunUI(${JSON.stringify(dryRunEnabled)});

    document.getElementById('dry-run-toggle').addEventListener('change', async function() {
      const enabled = this.checked;
      localStorage.setItem('dryRun', enabled ? 'true' : 'false');
      updateDryRunUI(enabled);
      try {
        await fetch('/set-dry-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        });
      } catch (e) {
        console.error('Failed to update dry-run state:', e.message);
      }
    });

    // On load: restore dry-run state from localStorage and sync with server.
    (function() {
      const stored = localStorage.getItem('dryRun');
      if (stored !== null) {
        const enabled = stored === 'true';
        document.getElementById('dry-run-toggle').checked = enabled;
        updateDryRunUI(enabled);
        fetch('/set-dry-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        }).catch(function() {});
      }
    })();

    // ---- Settings: stg-dry-run toggle ----
    document.getElementById('stg-dry-run').addEventListener('change', async function() {
      const enabled = this.checked;
      localStorage.setItem('dryRun', enabled ? 'true' : 'false');
      document.getElementById('dry-run-toggle').checked = enabled;
      updateDryRunUI(enabled);
      try {
        await fetch('/set-dry-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        });
      } catch (e) {
        console.error('Failed to update dry-run state:', e.message);
      }
    });

    // ---- Settings: stg-haptic toggle ----
    (function() {
      const stored = localStorage.getItem('hapticEnabled');
      if (stored !== null) {
        hapticEnabled = stored !== 'false';
        const stgHaptic = document.getElementById('stg-haptic');
        if (stgHaptic) stgHaptic.checked = hapticEnabled;
      }
    })();

    document.getElementById('stg-haptic').addEventListener('change', function() {
      hapticEnabled = this.checked;
      localStorage.setItem('hapticEnabled', hapticEnabled ? 'true' : 'false');
    });

    // ---- Settings: stg-pause toggle ----
    document.getElementById('stg-pause').addEventListener('change', function() {
      if (this.checked) {
        pauseScheduler();
      } else {
        resumeScheduler();
      }
    });

    // ---- Recent Failures panel ----
    var REASON_LABELS = {
      'time':             'Time mismatch',
      'instructor':       'Instructor mismatch',
      'time-instructor':  'Time + Instructor mismatch',
      'verify-time':      'Time mismatch',
      'verify-instructor':'Instructor mismatch',
      'verify-time-instructor': 'Time + Instructor mismatch',
    };
    function renderSummary(summary) {
      var el = document.getElementById('failure-summary');
      if (!el) return;
      var entries = Object.entries(summary).sort(function(a, b) { return b[1] - a[1]; });
      if (!entries.length) {
        el.innerHTML = '<span id="failure-summary-empty">No failures recorded.</span>';
        return;
      }
      el.innerHTML = '';
      entries.forEach(function(pair) {
        var key = pair[0], count = pair[1];
        var label = REASON_LABELS[key] || key;
        var item  = document.createElement('div');
        item.className = 'summary-item summary-reason-' + key;
        item.innerHTML = '<span class="summary-label">' + label + '</span><span class="summary-count">' + count + '</span>';
        el.appendChild(item);
      });
    }
    function loadFailures() {
      fetch('/api/failures').then(function(r){ return r.json(); }).then(function(data) {
        var files = Array.isArray(data) ? data : (data.recent || []);
        var summary = (!Array.isArray(data) && data.summary) ? data.summary : {};
        renderSummary(summary);
        var container = document.getElementById('failure-list');
        if (!container) return;
        if (!files.length) {
          container.innerHTML = '<span id="failure-list-empty">No failures recorded.</span>';
          return;
        }
        container.innerHTML = '';
        files.forEach(function(f) {
          var label = REASON_LABELS[f.reason] || ('Failure: ' + f.reason);
          var ts    = new Date(f.mtime).toLocaleString();
          var item  = document.createElement('div');
          item.className = 'failure-item';
          item.onclick   = function() { openTrace(f); };
          item.innerHTML =
            '<img class="failure-thumb" src="/screenshots/' + f.name + '" alt="' + f.reason + '">' +
            '<div><div class="failure-reason">\u274C ' + label + '</div><div class="failure-ts">' + ts + '</div></div>';
          container.appendChild(item);
        });
      }).catch(function(){});
    }
    loadFailures();
    setInterval(loadFailures, 10000);

    // ---- Mobile tab system (Now / Plan / Tools) ----

    function applyTab(tab) {
      if (!tab || !['now', 'plan', 'tools'].includes(tab)) tab = 'now';
      // Show/hide tab sections
      document.querySelectorAll('[data-tab-section]').forEach(function(el) {
        el.classList.toggle('tab-section-hidden', el.dataset.tabSection !== tab);
      });
      // Update active tab button
      document.querySelectorAll('.tab-seg-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
      // Sticky run bar: only visible in Tools tab
      var srb = document.getElementById('sticky-run-bar');
      if (srb) srb.classList.toggle('srb-hidden', tab !== 'tools');
      // Sync Now tab hero content when switching to Now
      if (tab === 'now') syncNowTab();
    }

    function setTab(tab) {
      try { localStorage.setItem('mobileTab', tab); } catch(e) {}
      applyTab(tab);
    }

    // Restore tab on load (default: Now)
    (function() {
      var saved = 'now';
      try { saved = localStorage.getItem('mobileTab') || 'now'; } catch(e) {}
      applyTab(saved);
    })();

    // ---- Trace viewer ----
    function openTrace(f) {
      var modal   = document.getElementById('trace-viewer');
      var img     = document.getElementById('trace-image');
      var details = document.getElementById('trace-details');
      if (!modal) return;
      img.src = '/screenshots/' + f.name;
      var meta = f.meta || {};
      var label = REASON_LABELS[f.reason] || ('Failure: ' + f.reason);
      var ts    = new Date(f.mtime).toLocaleString();
      details.innerHTML =
        '<div class="trace-row"><strong>Reason:</strong> ' + label + '</div>' +
        '<div class="trace-row"><strong>When:</strong> ' + ts + '</div>' +
        (meta.expectedTime     ? '<div class="trace-row"><strong>Expected time:</strong> ' + meta.expectedTime + '</div>' : '') +
        (meta.expectedInstructor ? '<div class="trace-row"><strong>Expected instructor:</strong> ' + meta.expectedInstructor + '</div>' : '') +
        (meta.classTitle       ? '<div class="trace-row"><strong>Class:</strong> ' + meta.classTitle + '</div>' : '') +
        (meta.modalPreview     ? '<div class="trace-row"><strong>Page text seen:</strong><div class="trace-preview">' + meta.modalPreview + '</div></div>' : '');
      modal.classList.remove('hidden');
    }
    (function() {
      var modal = document.getElementById('trace-viewer');
      var inner = modal && modal.querySelector('.trace-content');
      if (!modal) return;
      modal.addEventListener('click', function(e) {
        if (e.target === modal || e.target === document.getElementById('trace-close')) {
          modal.classList.add('hidden');
        }
      });
    })();

    // ---- Mobile refresh control ----

    // On page load: record the current time as "last updated" and display it.
    (function() {
      const el = document.getElementById('mrr-updated');
      if (!el) return;
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      el.textContent = 'Updated ' + timeStr;
    })();

    function mobileRefresh() {
      const btn   = document.getElementById('mobile-refresh-btn');
      const label = document.getElementById('mrr-label');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('spinning');
      if (label) label.textContent = 'Refreshing\u2026';
      // Brief visual pause so the spinner is visible before the reload fires.
      setTimeout(function() { location.reload(); }, 350);
    }
  </script>
</body>
</html>`;
}

// Minimal HTML-escape helper used in server-rendered job rows.
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Background job state
// ---------------------------------------------------------------------------
let jobState = { active: false, log: 'No job run yet.', success: null };

// Stage 10G — wire booking-bridge so the burst-to-booking handoff can set
// jobState.active (needed for isConfirming in Stage 10E and concurrency guards).
setBridgeCallbacks({
  isActive:  () => jobState.active,
  setActive: (v) => { jobState = { ...jobState, active: v }; },
});

function runInBackground(job) {
  jobState = { active: true, log: 'Logging in...', success: null };
  runBookingJob(job, { dryRun: getDryRun() })
    .then(result => {
      jobState = { active: false, log: result.message, success: result.status === 'success' };
      if (job.id) {
        const errMsg = result.status === 'error' ? (result.message || null) : null;
        setLastRun(job.id, result.status, errMsg);
      }
    })
    .catch(err => {
      jobState = { active: false, log: 'Error: ' + err.message, success: false };
      if (job.id) setLastRun(job.id, 'error', err.message || null);
    });
}

// Guard flag — prevents concurrent scrape requests.
let _scrapeRunning = false;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Parse URL once — handles query strings cleanly.
  const parsed = new URL(req.url, 'http://localhost');
  const path   = parsed.pathname;

  if (req.method === 'GET' && path === '/') {
    if (SERVE_REACT) {
      serveStatic(res, DIST_INDEX);
    } else {
      const jobs      = getAllJobs();
      const error     = parsed.searchParams.get('error')      || null;
      const editError = parsed.searchParams.get('edit_error') || null;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(buildHtml(jobs, error, editError));
    }

  } else if (req.method === 'GET' && path === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' });
    res.end(MANIFEST_JSON);

  } else if (req.method === 'GET' && (path === '/icon-192.png' || path === '/apple-touch-icon.png')) {
    const png = getCachedPng(192);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Content-Length': png.length });
    res.end(png);

  } else if (req.method === 'GET' && path === '/icon-512.png') {
    const png = getCachedPng(512);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Content-Length': png.length });
    res.end(png);

  } else if (req.method === 'GET' && path === '/status') {
    json(jobState);

  } else if (req.method === 'GET' && path === '/register') {
    if (jobState.active) { json({ started: false, log: 'Already running, please wait...' }); return; }
    runInBackground({ classTitle: 'Core Pilates', maxAttempts: 1 });
    json({ started: true });

  } else if (req.method === 'POST' && path === '/force-run-job') {
    const urlObj = new URL(req.url, 'http://localhost');
    const jobId  = parseInt(urlObj.searchParams.get('id'), 10);
    if (!jobId) { json({ success: false, message: 'Missing job id' }); return; }
    const dbJob = getJobById(jobId);
    if (!dbJob) { json({ success: false, message: `Job #${jobId} not found` }); return; }
    console.log(`\u26a0 FORCE RUN Job #${dbJob.id} (${dbJob.class_title}) — ignoring scheduler rules`);
    (async () => {
      try {
        const result = await runBookingJob({
          id:          dbJob.id,
          classTitle:  dbJob.class_title,
          classTime:   dbJob.class_time,
          instructor:  dbJob.instructor  || null,
          dayOfWeek:   dbJob.day_of_week,
          targetDate:  dbJob.target_date  || null,
        }, { dryRun: getDryRun() });
        const NON_SUCCESS_STATUSES = ['error', 'found_not_open_yet', 'not_found'];
        setLastRun(dbJob.id, result.status, NON_SUCCESS_STATUSES.includes(result.status) ? (result.message || null) : null);
        json({ success: !NON_SUCCESS_STATUSES.includes(result.status), message: `Job #${jobId}: ${result.status} — ${result.message}` });
      } catch (err) {
        console.error(`Force run error:`, err.message);
        setLastRun(dbJob.id, 'error', err.message);
        json({ success: false, message: err.message });
      }
    })();

  } else if (req.method === 'POST' && path === '/api/preflight') {
    // Safe readiness check: runs the full pipeline up to the modal action check
    // but does NOT click Register or Waitlist.  Updates sniper-state.json.
    // Does NOT call setLastRun — this is not a booking attempt.
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let jobId;
      try { jobId = JSON.parse(body).jobId; } catch { /* fall through */ }
      const dbJob = jobId ? getJobById(Number(jobId)) : (getAllJobs().find(j => j.is_active === 1) || null);
      if (!dbJob) { json({ success: false, message: 'No job found for preflight' }); return; }
      console.log(`[preflight] Running readiness check for Job #${dbJob.id} (${dbJob.class_title})`);
      (async () => {
        try {
          const result = await runBookingJob({
            id:         dbJob.id,
            classTitle: dbJob.class_title,
            classTime:  dbJob.class_time,
            instructor: dbJob.instructor  || null,
            dayOfWeek:  dbJob.day_of_week,
            targetDate: dbJob.target_date || null,
            maxAttempts: 1,
          }, { preflightOnly: true, dryRun: getDryRun() });
          const { loadState, savePreflightSnapshot } = require('../bot/sniper-readiness');
          const state = loadState();

          // ── Auth + Discovery detail ───────────────────────────────────────
          // Pull the most recent AUTH and DISCOVERY events from the event log
          // and surface their evidence to the UI.  Both events are always from
          // this run because preflight starts with AUTH before reaching DISCOVERY.
          const events = state?.events || [];

          // Auth detail — which provider was checked and what the outcome was.
          const authEvt = [...events].reverse().find(e => e.phase === 'AUTH');
          const authDetail = authEvt ? {
            verdict:  authEvt.failureType === 'AUTH_LOGIN_FAILED'    ? 'login_required'
                    : authEvt.failureType === 'AUTH_SESSION_EXPIRED'  ? 'session_expired'
                    :                                                   'ready',
            provider: authEvt.evidence?.provider ?? null,
            detail:   authEvt.message            ?? null,
          } : null;

          const discoveryEvt = [...events].reverse().find(e => e.phase === 'DISCOVERY');
          const discoveryDetail = discoveryEvt ? {
            found:      !discoveryEvt.failureType,
            matched:    discoveryEvt.evidence?.matched   ?? null,
            score:      discoveryEvt.evidence?.score     ?? null,
            signals:    discoveryEvt.evidence?.signals   ?? null,
            second:     discoveryEvt.evidence?.second    ?? null,
            nearMisses: discoveryEvt.evidence?.nearMisses ?? null,
          } : null;

          // Action detail — what booking action (if any) is available in the modal.
          // Two ACTION events may exist per run:
          //   1. detection event  — always has evidence.actionState + buttonsVisible
          //   2. resolution event — records the final outcome (may lack button evidence)
          // We combine both: button details from detection, final verdict from resolution.
          const actionEvts = [...events].reverse().filter(e => e.phase === 'ACTION');
          const actionDetectEvt  = actionEvts.find(e => e.evidence?.actionState);
          const actionResolveEvt = actionEvts[0]; // most recent = final resolution

          const rawActionState = actionDetectEvt?.evidence?.actionState ?? null;
          // Map detection actionState → user-facing verdict. Fall back to the
          // resolution event failureType when the detection event is absent.
          const actionVerdict =
              rawActionState === 'REGISTER_AVAILABLE'
           || rawActionState === 'RESERVE_AVAILABLE'   ? 'ready'
            : rawActionState === 'WAITLIST_AVAILABLE'  ? 'waitlist_only'
            : rawActionState === 'LOGIN_REQUIRED'      ? 'login_required'
            : rawActionState === 'CANCEL_ONLY'         ? 'full'
            : rawActionState === 'UNKNOWN_ACTION'      ? 'full'
            // No detection evidence — fall back to resolution event failureType
            : actionResolveEvt?.failureType === 'WAITLIST_ONLY'    ? 'waitlist_only'
            : actionResolveEvt?.failureType === 'ACTION_NOT_FOUND' ? 'full'
            : actionResolveEvt && !actionResolveEvt.failureType    ? 'ready'
            : 'unknown';

          const actionDetail = (actionDetectEvt || actionResolveEvt) ? {
            verdict:          actionVerdict,
            actionState:      rawActionState,
            buttonsVisible:   actionDetectEvt?.evidence?.buttonsVisible  ?? null,
            registerStrategy: actionDetectEvt?.evidence?.registerStrategy ?? null,
            waitlistStrategy: actionDetectEvt?.evidence?.waitlistStrategy ?? null,
            detail:           actionResolveEvt?.message ?? actionDetectEvt?.message ?? null,
          } : null;

          // Modal detail — whether the class modal could be opened after card click.
          // Failure screenshots are stored on disk and linked via evidence.screenshot.
          const modalEvt = [...events].reverse().find(e => e.phase === 'MODAL');
          const modalDetail = modalEvt ? {
            verdict:        modalEvt.failureType === 'MODAL_NOT_OPENED'     ? 'blocked'
                          : modalEvt.failureType === 'MODAL_LOGIN_REQUIRED' ? 'login_required'
                          :                                                   'reachable',
            detail:         modalEvt.message            ?? null,
            screenshot:     modalEvt.evidence?.screenshot ?? null,
            buttonsVisible: modalEvt.evidence?.buttonsVisible ?? null,
            modalPreview:   modalEvt.evidence?.modalPreview  ?? null,
          } : null;

          // Persist the full preflight result so the frontend can restore the
          // composite badge and per-stage detail subtitles after a page refresh.
          savePreflightSnapshot(result.status, { authDetail, discoveryDetail, modalDetail, actionDetail });
          const stateAfterSnapshot = loadState();

          // Stage 9B — update the normalized persisted readiness state.
          const { refreshReadiness } = require('../bot/readiness-state');
          refreshReadiness({ jobId: dbJob.id, classTitle: dbJob.class_title, source: 'manual' });

          json({
            success:         result.status === 'success',
            status:          result.status,
            message:         result.message,
            sniperState:     stateAfterSnapshot,
            authDetail,
            discoveryDetail,
            modalDetail,
            actionDetail,
          });
        } catch (err) {
          console.error('[preflight] error:', err.message);
          json({ success: false, message: err.message, sniperState: null });
        }
      })();
    });

  } else if (req.method === 'POST' && path === '/api/dry-run') {
    // Runs the full booking pipeline with dryRun=true — goes all the way to
    // the Register/Waitlist button but never clicks it.  Safe to run any time.
    // Uses the selected job; returns a human-readable outcome.
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      (async () => {
        try {
          const { jobId } = JSON.parse(body || '{}');
          const dbJob = getJobById(Number(jobId));
          if (!dbJob) { json({ success: false, message: 'Job not found' }); return; }

          const result = await runBookingJob({
            id:         dbJob.id,
            classTitle: dbJob.class_title,
            classTime:  dbJob.class_time,
            instructor: dbJob.instructor  || null,
            dayOfWeek:  dbJob.day_of_week,
            targetDate: dbJob.target_date || null,
            maxAttempts: 1,
          }, { dryRun: true });

          // Map raw bot status to a user-readable label and color.
          const label =
            result.status === 'success'      ? 'Would register'    :
            result.status === 'waitlist_only'? 'Would join waitlist':
            result.status === 'found_not_open_yet' ? 'Not open yet' :
            result.status === 'not_found'    ? 'Class not found'   :
            'Run failed';
          const color =
            result.status === 'success'      ? 'green' :
            result.status === 'waitlist_only'? 'amber' :
            'red';

          json({ success: result.status === 'success', status: result.status, message: result.message, label, color });
        } catch (err) {
          console.error('[dry-run] error:', err.message);
          json({ success: false, status: 'error', message: err.message, label: 'Run failed', color: 'red' });
        }
      })();
    });

  } else if (req.method === 'GET' && path === '/api/session-status') {
    // Returns the persisted result of the last session check (fast, no browser).
    // Also derives per-provider status from sniper-state.json (no browser launched).
    const { loadStatus } = require('../bot/session-check');
    const raw = loadStatus() || { valid: null, checkedAt: null, detail: null, screenshot: null };

    // ── Derive Daxko status ───────────────────────────────────────────────────
    let daxko = 'AUTH_UNKNOWN';
    if (raw.valid === true)  daxko = 'DAXKO_READY';
    if (raw.valid === false) daxko = 'AUTH_NEEDS_LOGIN';

    // ── Derive FamilyWorks status ─────────────────────────────────────────────
    // Priority 1: familyworks-session.json written by Settings > Log in now
    // Priority 2: sniper-state.json bundle.session (written by booking runs)
    // Whichever has the more recent checkedAt/timestamp wins.
    let familyworks = 'AUTH_UNKNOWN';
    let sniperLastEventAt = null;
    let fwCheckedAt = null;

    // Read familyworks-session.json (Settings login result)
    let fwSettingsEntry = null;
    try {
      const fwPath = pathStatic.join(__dirname, '../data/familyworks-session.json');
      if (fsStatic.existsSync(fwPath)) {
        fwSettingsEntry = JSON.parse(fsStatic.readFileSync(fwPath, 'utf8'));
        fwCheckedAt = fwSettingsEntry?.checkedAt || null;
      }
    } catch (_) { /* non-fatal */ }

    // Read sniper-state.json (booking run result)
    let sniperEntry = null;
    try {
      const sniperPath = pathStatic.join(__dirname, '../data/sniper-state.json');
      if (fsStatic.existsSync(sniperPath)) {
        sniperEntry = JSON.parse(fsStatic.readFileSync(sniperPath, 'utf8'));
        const events = Array.isArray(sniperEntry?.events) ? sniperEntry.events : [];
        if (events.length > 0) {
          sniperLastEventAt = events[events.length - 1].timestamp || null;
        }
      }
    } catch (_) { /* non-fatal */ }

    // Determine which source is more recent and use it
    const fwSettingsMs = fwCheckedAt ? new Date(fwCheckedAt).getTime() : 0;
    const sniperMs     = sniperLastEventAt ? new Date(sniperLastEventAt).getTime() : 0;

    if (fwSettingsMs >= sniperMs && fwSettingsEntry) {
      // Settings login result is newer (or equal) — use it
      familyworks = fwSettingsEntry.status || 'AUTH_UNKNOWN';
    } else if (sniperEntry) {
      // Booking run result is newer — derive from sniper-state
      const bundleSession = sniperEntry?.bundle?.session;
      const events = Array.isArray(sniperEntry?.events) ? sniperEntry.events : [];
      const hasModalLoginEvent = events.some(e => e.failureType === 'MODAL_LOGIN_REQUIRED');
      if (bundleSession === 'SESSION_READY') {
        familyworks = 'FAMILYWORKS_READY';
      } else if (bundleSession === 'SESSION_EXPIRED' || hasModalLoginEvent) {
        familyworks = 'FAMILYWORKS_SESSION_MISSING';
      }
    }

    // ── Derive overall status ─────────────────────────────────────────────────
    let overall = 'AUTH_UNKNOWN';
    if (daxko === 'AUTH_NEEDS_LOGIN') {
      overall = 'AUTH_NEEDS_LOGIN';
    } else if (familyworks === 'FAMILYWORKS_SESSION_MISSING') {
      overall = 'FAMILYWORKS_SESSION_MISSING';
    } else if (daxko === 'DAXKO_READY' && familyworks === 'FAMILYWORKS_READY') {
      overall = 'DAXKO_READY';
    }
    // else: at least one side is AUTH_UNKNOWN → overall stays AUTH_UNKNOWN

    // ── Last verified: most recent known timestamp ────────────────────────────
    const candidates = [raw.checkedAt, sniperLastEventAt, fwCheckedAt].filter(Boolean);
    const lastVerified = candidates.length > 0
      ? candidates.reduce((a, b) => (a > b ? a : b))
      : null;

    json({ ...raw, daxko, familyworks, overall, lastVerified, locked: !!(jobState.active || isAuthLocked()) });

  } else if (req.method === 'POST' && path === '/api/session-check') {
    // Runs a dedicated login check — login only, no booking pipeline.
    // Checks Daxko credentials via a live browser login, then reads the most
    // recent FamilyWorks session status from persisted files (no FW browser run).
    // Emits a SESSION_VERIFY event to sniper-state.json so it appears in Tools.
    // Does NOT call setLastRun; does NOT reset the readiness bundle.
    if (jobState.active) {
      // Return valid:null (not false) so the UI does not show a red auth-failure
      // notice — "bot busy" is different from "login failed."
      json({ valid: null, checkedAt: null, detail: 'Bot is currently running — try again when it finishes', screenshot: null, label: 'Bot busy', daxko: 'AUTH_UNKNOWN', familyworks: 'AUTH_UNKNOWN' });
      return;
    }
    (async () => {
      try {
        const { runSessionCheck } = require('../bot/session-check');
        const result = await runSessionCheck();

        // ── Daxko status ────────────────────────────────────────────────────
        const daxko = result.valid === true  ? 'DAXKO_READY'
                    : result.valid === false ? 'AUTH_NEEDS_LOGIN'
                    :                         'AUTH_UNKNOWN';

        // ── FamilyWorks status (file-based, no additional browser run) ──────
        // Reads familyworks-session.json written by preflight / Settings login.
        // Treats entries older than 6 hours as Unknown to avoid stale "Ready".
        let familyworks = 'AUTH_UNKNOWN';
        try {
          const fwPath = pathStatic.join(__dirname, '../data/familyworks-session.json');
          if (fsStatic.existsSync(fwPath)) {
            const fwData = JSON.parse(fsStatic.readFileSync(fwPath, 'utf8'));
            const ageMs  = Date.now() - new Date(fwData.checkedAt || 0).getTime();
            if (ageMs < 6 * 3600 * 1000) {
              familyworks = fwData.status || 'AUTH_UNKNOWN';
            }
            // else: FW status is stale — leave as AUTH_UNKNOWN
          }
        } catch (_) { /* non-fatal — familyworks stays AUTH_UNKNOWN */ }

        // ── Human-readable result label ─────────────────────────────────────
        let label;
        if (result.valid === null) {
          label = 'Bot busy';
        } else if (daxko !== 'DAXKO_READY') {
          label = 'Login required';
        } else if (familyworks === 'FAMILYWORKS_READY') {
          label = 'Session ready';
        } else if (familyworks === 'FAMILYWORKS_SESSION_MISSING') {
          label = 'Schedule access missing';
        } else {
          // Daxko confirmed; FW stale or unknown — partial verification
          label = 'Session ready';
        }

        // ── Log to Tools (sniper-state event log) ───────────────────────────
        try {
          const { emitSessionCheck } = require('../bot/sniper-readiness');
          emitSessionCheck(daxko, familyworks, `Verify Session: ${label} — ${result.detail || ''}`);
        } catch (_) { /* non-fatal */ }

        json({ ...result, daxko, familyworks, label });
      } catch (err) {
        console.error('[session-check] route error:', err.message);
        json({ valid: false, checkedAt: new Date().toISOString(), detail: err.message, screenshot: null, label: 'Verification failed', daxko: 'AUTH_UNKNOWN', familyworks: 'AUTH_UNKNOWN' });
      }
    })();

  } else if (req.method === 'POST' && path === '/api/settings-login') {
    // Full login + FamilyWorks session establishment, triggered from Settings.
    // Rejects if the booking bot or another auth operation is currently running.
    if (jobState.active) {
      json({ success: false, locked: true, detail: 'A booking run is in progress — try again when it finishes.' });
      return;
    }
    if (isAuthLocked()) {
      json({ success: false, locked: true, detail: 'A booking run is in progress — try again when it finishes.' });
      return;
    }
    (async () => {
      if (!acquireAuthLock('settings-login')) {
        json({ success: false, locked: true, detail: 'A booking run is in progress — try again when it finishes.' });
        return;
      }
      try {
        const { runSettingsLogin } = require('../bot/settings-auth');
        const result = await runSettingsLogin({ source: 'settings' });
        json({ success: true, ...result });
      } catch (err) {
        console.error('[settings-auth] route error:', err.message);
        json({ success: false, detail: err.message || 'Login failed unexpectedly' });
      } finally {
        releaseAuthLock();
      }
    })();

  } else if (req.method === 'POST' && path === '/api/settings-refresh') {
    // Session revalidation triggered from AccountSheet > Refresh connection.
    //
    // Escalation (Tier-1 skipped — user asked for active network verification):
    //   Tier 2: HTTP ping via saved cookies (~1–5 s, no browser)
    //   Tier 3: Full Playwright check via runSessionCheck (~30 s, fallback)
    //
    // Does NOT attempt FamilyWorks SSO or modal interaction — use Log in now for that.
    // Does NOT auto-login if invalid — simply reports AUTH_NEEDS_LOGIN.
    if (jobState.active) {
      json({ success: false, locked: true, detail: 'A booking run is in progress — try again when it finishes.' });
      return;
    }
    if (isAuthLocked()) {
      json({ success: false, locked: true, detail: 'A booking run is in progress — try again when it finishes.' });
      return;
    }
    (async () => {
      if (!acquireAuthLock('settings-refresh')) {
        json({ success: false, locked: true, detail: 'A booking run is in progress — try again when it finishes.' });
        return;
      }
      try {
        console.log('[settings-refresh] Starting session refresh (Tier-2 first)...');

        // ── Tier 2: HTTP ping using saved browser cookies ─────────────────────
        const { pingSessionHttp } = require('../bot/session-ping');
        const pingResult = await pingSessionHttp();

        if (pingResult.trusted) {
          // Both Daxko and FamilyWorks confirmed via HTTP — no browser needed.
          console.log('[settings-refresh] Tier-2 ping succeeded:', pingResult.detail);

          // Read the FamilyWorks status from the freshly-stamped session file.
          // pingSessionHttp() verified FamilyWorks via HTTP AND called refreshStatusTimestamps(),
          // so familyworks-session.json is up to date with a fresh checkedAt.
          // Sniper-state recency comparison is intentionally skipped here: the HTTP ping
          // already confirmed the live FamilyWorks session, making sniper-state stale
          // by definition. Defaulting to FAMILYWORKS_READY when the file is absent is
          // correct because the ping just proved the session is active.
          let familyworks = 'FAMILYWORKS_READY';
          let fwCheckedAt = null;
          try {
            const fwPath = pathStatic.join(__dirname, '../data/familyworks-session.json');
            if (fsStatic.existsSync(fwPath)) {
              const fwEntry = JSON.parse(fsStatic.readFileSync(fwPath, 'utf8'));
              familyworks = fwEntry?.status || 'FAMILYWORKS_READY';
              fwCheckedAt = fwEntry?.checkedAt || null;
            }
          } catch (_) { /* non-fatal */ }

          const lastVerified = fwCheckedAt || new Date().toISOString();
          const overall = familyworks === 'FAMILYWORKS_READY' ? 'DAXKO_READY' : familyworks;
          const detail  = `Tier-2: ${pingResult.detail}`;
          console.log('[settings-refresh] Done (Tier-2).', { daxko: 'DAXKO_READY', familyworks });

          json({ success: true, daxko: 'DAXKO_READY', familyworks, overall, lastVerified, detail, tier: 2 });
          return;
        }

        // ── Tier 2 missed — fall through to Tier-3 Playwright check ──────────
        console.log('[settings-refresh] Tier-2 miss:', pingResult.detail);
        console.log('[settings-refresh] Falling through to Tier-3 Playwright check...');

        // ── Tier 3: Daxko check via full Playwright login ─────────────────────
        const { runSessionCheck } = require('../bot/session-check');
        const checkResult = await runSessionCheck({ source: 'refresh' });

        const daxko = checkResult.valid ? 'DAXKO_READY' : 'AUTH_NEEDS_LOGIN';
        console.log(`[settings-refresh] Tier-3 Daxko: ${daxko} — ${checkResult.detail}`);

        // ── FamilyWorks — read from persisted files, no browser ───────────
        let familyworks = 'AUTH_UNKNOWN';
        let fwCheckedAt  = null;
        let sniperLastAt = null;

        try {
          const fwPath = pathStatic.join(__dirname, '../data/familyworks-session.json');
          if (fsStatic.existsSync(fwPath)) {
            const fwEntry = JSON.parse(fsStatic.readFileSync(fwPath, 'utf8'));
            fwCheckedAt = fwEntry?.checkedAt || null;
            const fwSettingsMs = fwCheckedAt ? new Date(fwCheckedAt).getTime() : 0;

            // Also read sniper-state to compare recency
            let sniperMs = 0;
            let sniperFw = null;
            const sniperPath = pathStatic.join(__dirname, '../data/sniper-state.json');
            if (fsStatic.existsSync(sniperPath)) {
              const sniper = JSON.parse(fsStatic.readFileSync(sniperPath, 'utf8'));
              const events = Array.isArray(sniper?.events) ? sniper.events : [];
              sniperLastAt = events.length > 0 ? (events[events.length - 1].timestamp || null) : null;
              sniperMs     = sniperLastAt ? new Date(sniperLastAt).getTime() : 0;
              const bundleSession = sniper?.bundle?.session;
              const hasModal = events.some(e => e.failureType === 'MODAL_LOGIN_REQUIRED');
              if (bundleSession === 'SESSION_READY') sniperFw = 'FAMILYWORKS_READY';
              else if (bundleSession === 'SESSION_EXPIRED' || hasModal) sniperFw = 'FAMILYWORKS_SESSION_MISSING';
            }

            if (fwSettingsMs >= sniperMs) {
              familyworks = fwEntry.status || 'AUTH_UNKNOWN';
            } else if (sniperFw) {
              familyworks = sniperFw;
            }
          } else {
            // No familyworks-session.json — fall back to sniper-state only
            const sniperPath = pathStatic.join(__dirname, '../data/sniper-state.json');
            if (fsStatic.existsSync(sniperPath)) {
              const sniper = JSON.parse(fsStatic.readFileSync(sniperPath, 'utf8'));
              const events = Array.isArray(sniper?.events) ? sniper.events : [];
              sniperLastAt = events.length > 0 ? (events[events.length - 1].timestamp || null) : null;
              const bundleSession = sniper?.bundle?.session;
              const hasModal = events.some(e => e.failureType === 'MODAL_LOGIN_REQUIRED');
              if (bundleSession === 'SESSION_READY') familyworks = 'FAMILYWORKS_READY';
              else if (bundleSession === 'SESSION_EXPIRED' || hasModal) familyworks = 'FAMILYWORKS_SESSION_MISSING';
            }
          }
        } catch (_) { /* non-fatal — leave familyworks as AUTH_UNKNOWN */ }

        console.log(`[settings-refresh] FamilyWorks: ${familyworks} (from persisted state)`);

        // ── Derive overall ────────────────────────────────────────────────
        let overall = 'AUTH_UNKNOWN';
        if (daxko === 'AUTH_NEEDS_LOGIN') {
          overall = 'AUTH_NEEDS_LOGIN';
        } else if (familyworks === 'FAMILYWORKS_SESSION_MISSING') {
          overall = 'FAMILYWORKS_SESSION_MISSING';
        } else if (daxko === 'DAXKO_READY' && familyworks === 'FAMILYWORKS_READY') {
          overall = 'DAXKO_READY';
        }

        // ── Last verified: most recent of all known timestamps ────────────
        const stamps = [checkResult.checkedAt, fwCheckedAt, sniperLastAt].filter(Boolean);
        const lastVerified = stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : null;

        const detail = `Daxko: ${daxko} | FamilyWorks: ${familyworks} — ${checkResult.detail}`;
        console.log('[settings-refresh] Done (Tier-3).', { daxko, familyworks, overall });

        json({ success: true, daxko, familyworks, overall, lastVerified, detail, tier: 3 });
      } catch (err) {
        console.error('[settings-refresh] route error:', err.message);
        json({ success: false, detail: err.message || 'Refresh failed unexpectedly' });
      } finally {
        releaseAuthLock();
      }
    })();

  } else if (req.method === 'POST' && path === '/api/settings-clear') {
    // Instantly wipes all persisted auth state. No browser launched.
    // Overwrites session-status.json and familyworks-session.json with cleared
    // values, and resets bundle.session in sniper-state.json to SESSION_UNKNOWN
    // (events array is preserved for run history).
    try {
      const now = new Date().toISOString();
      const dataDir = pathStatic.join(__dirname, '../data');

      // ── session-status.json ───────────────────────────────────────────────
      fsStatic.writeFileSync(
        pathStatic.join(dataDir, 'session-status.json'),
        JSON.stringify({ valid: false, checkedAt: now, source: 'clear', detail: 'Session cleared by user' }, null, 2)
      );

      // ── familyworks-session.json ──────────────────────────────────────────
      fsStatic.writeFileSync(
        pathStatic.join(dataDir, 'familyworks-session.json'),
        JSON.stringify({ ready: false, status: 'FAMILYWORKS_SESSION_MISSING', checkedAt: now, source: 'clear', detail: 'Session cleared by user' }, null, 2)
      );

      // ── sniper-state.json — reset bundle.session only, keep everything else ─
      const sniperPath = pathStatic.join(dataDir, 'sniper-state.json');
      let sniper = {};
      if (fsStatic.existsSync(sniperPath)) {
        try { sniper = JSON.parse(fsStatic.readFileSync(sniperPath, 'utf8')); } catch (_) {}
      }
      if (!sniper.bundle) sniper.bundle = {};
      sniper.bundle.session = 'SESSION_UNKNOWN';
      fsStatic.writeFileSync(sniperPath, JSON.stringify(sniper, null, 2));

      console.log('[settings-clear] Auth state cleared.');
      json({
        success: true,
        daxko: 'AUTH_NEEDS_LOGIN',
        familyworks: 'FAMILYWORKS_SESSION_MISSING',
        overall: 'AUTH_NEEDS_LOGIN',
        lastVerified: null,
        detail: 'Session cleared. Log in before the next booking run.',
      });
    } catch (err) {
      console.error('[settings-clear] error:', err.message);
      json({ success: false, detail: err.message || 'Clear failed unexpectedly' });
    }

  } else if (req.method === 'GET' && path === '/api/auto-preflight-config') {
    // Returns settings, last run info, and the next scheduled trigger.
    const settings    = loadAutoPreflightSettings();
    const entries     = loadAutoPreflightLog();
    const lastEntry   = entries.length > 0 ? entries[entries.length - 1] : null;
    const nextTrigger = getNextAutoTrigger();
    json({ enabled: settings.enabled, lastRun: lastEntry, nextTrigger });

  } else if (req.method === 'POST' && path === '/api/auto-preflight-config') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body);
        if (typeof enabled !== 'boolean') { json({ success: false, message: 'enabled must be boolean' }); return; }
        saveAutoPreflightSettings({ enabled });
        json({ success: true, enabled });
      } catch {
        json({ success: false, message: 'Invalid body' });
      }
    });

  } else if (req.method === 'GET' && path === '/api/session-keepalive-config') {
    // Returns keepalive settings, last run info, and next scheduled time.
    json(getKeepaliveConfig());

  } else if (req.method === 'POST' && path === '/api/session-keepalive-config') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { enabled, intervalMinutes, intervalHours } = JSON.parse(body);
        if (typeof enabled !== 'boolean') { json({ success: false, message: 'enabled must be boolean' }); return; }
        // Accept intervalMinutes (new) or intervalHours (legacy) from callers.
        const minutes = typeof intervalMinutes === 'number' && intervalMinutes > 0
          ? intervalMinutes
          : (typeof intervalHours === 'number' && intervalHours > 0 ? Math.round(intervalHours * 60) : 12);
        saveKeepaliveSettings({ enabled, intervalMinutes: minutes });
        json({ success: true, enabled, intervalMinutes: minutes, intervalHours: Math.round(minutes / 60) });
      } catch {
        json({ success: false, message: 'Invalid body' });
      }
    });

  } else if (req.method === 'GET' && path === '/run-job') {
    if (jobState.active) { json({ started: false, log: 'Already running, please wait...' }); return; }
    const id    = parsed.searchParams.get('id');
    const dbJob = id ? getJobById(Number(id)) : getJobById(1);
    if (!dbJob) {
      json({ started: false, log: `No job found with id ${id || 1}. Run: npm run db:test` });
      return;
    }
    console.log(`Running job #${dbJob.id} (${dbJob.class_title}) from DB`);
    runInBackground({
      id:          dbJob.id,
      classTitle:  dbJob.class_title,
      classTime:   dbJob.class_time,
      instructor:  dbJob.instructor   || null,
      dayOfWeek:   dbJob.day_of_week,
      targetDate:  dbJob.target_date  || null,
      maxAttempts: 1,
    });
    json({ started: true });

  } else if (req.method === 'GET' && path === '/clean-test-jobs') {
    const db     = openDb();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const deleted = db.prepare(
      `DELETE FROM jobs WHERE class_title = 'Core Pilates' AND created_at < ?`
    ).run(cutoff);
    const remaining = db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
    json({ success: true, log: `Deleted ${deleted.changes} old test job(s). Remaining jobs: ${remaining}` });

  } else if (req.method === 'POST' && path === '/update-job') {
    const isJsonUp = (req.headers['content-type'] || '').includes('application/json');
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let id, classTitle, dayOfWeek, classTime, instructor, targetDate;

      if (isJsonUp) {
        let parsed;
        try { parsed = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          return;
        }
        id         = parseInt(parsed.id, 10);
        classTitle = (parsed.class_title  || '').trim();
        dayOfWeek  = (parsed.day_of_week  != null ? String(parsed.day_of_week) : '').trim();
        classTime  = (parsed.class_time   || '').trim();
        instructor = (parsed.instructor   || '').trim();
        targetDate = parsed.target_date   || null;

        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid job ID' }));
          return;
        }
        const missing = [];
        if (!classTitle) missing.push('class name');
        if (!dayOfWeek)  missing.push('day');
        if (!classTime)  missing.push('time');
        if (missing.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Missing required fields: ' + missing.join(', ') }));
          return;
        }
        updateJob(id, { classTitle, dayOfWeek, classTime, instructor: instructor || null, targetDate: targetDate || null });
        console.log(`Updated job #${id} via React UI: ${classTitle} / ${dayOfWeek} / ${classTime}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        const fields = {};
        body.split('&').forEach(pair => {
          const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
          if (k) fields[k] = (v || '').trim();
        });
        id         = parseInt(fields.job_id, 10);
        classTitle = fields.title      || '';
        dayOfWeek  = fields.day        || '';
        classTime  = fields.time       || '';
        instructor = fields.instructor || '';
        targetDate = fields.target_date || null;

        if (!id) { res.writeHead(302, { Location: '/?edit_error=Invalid+job+ID' }); res.end(); return; }
        const missing = [];
        if (!classTitle) missing.push('title');
        if (!dayOfWeek)  missing.push('day');
        if (!classTime)  missing.push('time');
        if (!instructor) missing.push('instructor');
        if (missing.length > 0) {
          const msg = encodeURIComponent('Missing required fields: ' + missing.join(', '));
          res.writeHead(302, { Location: '/?edit_error=' + msg }); res.end(); return;
        }
        updateJob(id, { classTitle, dayOfWeek, classTime, instructor, targetDate: targetDate || null });
        console.log(`Updated job #${id} via web form`);
        res.writeHead(302, { Location: '/' }); res.end();
      }
    });

  } else if (req.method === 'POST' && path === '/toggle-active') {
    const isJsonTa = (req.headers['content-type'] || '').includes('application/json');
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let id, newActive;
      if (isJsonTa) {
        try {
          const parsed = JSON.parse(body);
          id = parseInt(parsed.id, 10);
          if (parsed.is_active !== undefined) {
            newActive = !!parsed.is_active;
          } else {
            const existing = id ? getJobById(id) : null;
            newActive = existing ? !existing.is_active : true;
          }
        } catch { id = NaN; newActive = false; }
      } else {
        const fields = {};
        body.split('&').forEach(pair => {
          const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
          if (k) fields[k] = (v || '').trim();
        });
        id       = parseInt(fields.job_id, 10);
        newActive = fields.is_active === '1';
      }
      if (id) {
        setJobActive(id, newActive);
        console.log(`Set job #${id} is_active=${newActive}`);
      }
      if (isJsonTa) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !!id, is_active: newActive }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    });

  } else if (req.method === 'POST' && path === '/delete-job') {
    const isJsonDel = (req.headers['content-type'] || '').includes('application/json');
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let id;
      if (isJsonDel) {
        try { id = parseInt(JSON.parse(body).id, 10); } catch { id = NaN; }
      } else {
        const fields = {};
        body.split('&').forEach(pair => {
          const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
          if (k) fields[k] = (v || '').trim();
        });
        id = parseInt(fields.job_id, 10);
      }
      if (id) {
        deleteJob(id);
        console.log(`Deleted job #${id}`);
      }
      if (isJsonDel) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !!id }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    });

  } else if (req.method === 'POST' && path === '/reset-booking') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let id;
      try { id = parseInt(JSON.parse(body).id, 10); } catch { id = NaN; }
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid job ID' }));
        return;
      }
      clearLastRun(id);
      console.log(`Reset booking state for job #${id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

  } else if (req.method === 'POST' && path === '/add-job') {
    const isJson = (req.headers['content-type'] || '').includes('application/json');
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let classTitle, dayOfWeek, classTime, instructor, targetDate;

      if (isJson) {
        // React app sends JSON with snake_case field names.
        let parsed;
        try { parsed = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          return;
        }
        classTitle = (parsed.class_title  || '').trim();
        dayOfWeek  = (parsed.day_of_week  != null ? String(parsed.day_of_week) : '').trim();
        classTime  = (parsed.class_time   || '').trim();
        instructor = (parsed.instructor   || '').trim();
        targetDate = parsed.target_date   || null;

        const missing = [];
        if (!classTitle) missing.push('class name');
        if (!dayOfWeek)  missing.push('day');
        if (!classTime)  missing.push('time');
        if (missing.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Missing required fields: ' + missing.join(', ') }));
          return;
        }
        const id = createJob({ classTitle, dayOfWeek, classTime, instructor: instructor || null, targetDate: targetDate || null });
        console.log(`Created job #${id} via React UI: ${classTitle} / ${dayOfWeek} / ${classTime}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id }));
      } else {
        // Old HTML form sends URL-encoded data.
        const fields = {};
        body.split('&').forEach(pair => {
          const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
          if (k) fields[k] = (v || '').trim();
        });
        classTitle = fields.title      || '';
        dayOfWeek  = fields.day        || '';
        classTime  = fields.time       || '';
        instructor = fields.instructor || '';
        targetDate = fields.target_date || null;

        const missing = [];
        if (!classTitle) missing.push('title');
        if (!dayOfWeek)  missing.push('day');
        if (!classTime)  missing.push('time');
        if (!instructor) missing.push('instructor');
        if (missing.length > 0) {
          const msg = encodeURIComponent('Missing required fields: ' + missing.join(', '));
          res.writeHead(302, { Location: '/?error=' + msg });
          res.end();
          return;
        }
        const id = createJob({ classTitle, dayOfWeek, classTime, instructor, targetDate: targetDate || null });
        console.log(`Created job #${id} via web form: ${classTitle} / ${dayOfWeek} / ${classTime}`);
        res.writeHead(302, { Location: '/' });
        res.end();
      }
    });

  } else if (req.method === 'POST' && path === '/run-scheduler-once') {
    (async () => {
      try {
        const results = await runTick();
        const ran     = results.filter(r => r.status !== 'skipped');
        const skipped = results.filter(r => r.status === 'skipped');
        const summary = ran.length
          ? ran.map(r => `Job #${r.jobId}: ${r.status} — ${r.message}`).join('; ')
          : 'No eligible jobs ran';
        const detail  = skipped.length
          ? ` (${skipped.length} skipped)`
          : '';
        json({ success: true, message: summary + detail, results });
      } catch (err) {
        console.error('run-scheduler-once error:', err.message);
        json({ success: false, message: err.message });
      }
    })();

  } else if (req.method === 'POST' && path === '/run-selected-scheduler') {
    const urlObj = new URL(req.url, `http://localhost`);
    const jobId  = parseInt(urlObj.searchParams.get('id'), 10);
    if (!jobId) { json({ success: false, message: 'Missing job id' }); return; }
    (async () => {
      try {
        const results = await runTick({ onlyJobId: jobId });
        const r = results[0];
        if (!r) {
          json({ success: true, message: `Job #${jobId} not found or inactive — nothing ran` });
        } else if (r.status === 'skipped') {
          json({ success: true, message: `Job #${jobId} skipped — ${r.message}` });
        } else {
          json({ success: r.status !== 'error', message: `Job #${jobId}: ${r.status} — ${r.message}`, result: r });
        }
      } catch (err) {
        console.error('run-selected-scheduler error:', err.message);
        json({ success: false, message: err.message });
      }
    })();

  } else if (req.method === 'POST' && path === '/pause-scheduler') {
    setSchedulerPaused(true);
    console.log('Scheduler paused via UI.');
    json({ ok: true, paused: true });

  } else if (req.method === 'POST' && path === '/resume-scheduler') {
    setSchedulerPaused(false);
    console.log('Scheduler resumed via UI.');
    json({ ok: true, paused: false });

  } else if (req.method === 'POST' && path === '/set-dry-run') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body);
        setDryRun(!!enabled);
        console.log(`Dry run ${getDryRun() ? 'ENABLED' : 'DISABLED'} via UI.`);
        json({ success: true, dryRun: getDryRun() });
      } catch {
        json({ success: false, message: 'Invalid JSON' });
      }
    });
    return;

  } else if (req.method === 'GET' && path === '/api/jobs') {
    json(getAllJobs());

  } else if (req.method === 'GET' && path === '/api/state') {
    const rawJobs = getAllJobs();
    // Enrich every job with its own phase + bookingOpenMs (one getPhase call each).
    const jobs = rawJobs.map(j => {
      try {
        const r = getPhase(j);
        return { ...j, phase: r.phase, bookingOpenMs: r.bookingOpen ? r.bookingOpen.getTime() : null };
      } catch (_) {
        return { ...j, phase: 'unknown', bookingOpenMs: null };
      }
    });
    // Top-level phase + bookingOpenMs reuse the enriched first-active job's values.
    const firstActive = jobs.find(j => j.is_active) || jobs[0] || null;
    const phase       = firstActive ? firstActive.phase       : 'unknown';
    const bookingOpenMs = firstActive ? firstActive.bookingOpenMs : null;
    json({
      schedulerPaused: isSchedulerPaused(),
      dryRun: getDryRun(),
      selectedJobId: firstActive ? firstActive.id : null,
      phase,
      bookingOpenMs,
      jobs,
    });

  } else if (req.method === 'GET' && path === '/api/sniper-state') {
    const { loadState } = require('../bot/sniper-readiness');
    const sniperState = loadState();
    json(sniperState || {
      runId: null, jobId: null, phase: null,
      bundle: { session: 'SESSION_UNKNOWN', discovery: 'DISCOVERY_NOT_TESTED', action: 'ACTION_NOT_TESTED', modal: 'MODAL_NOT_TESTED' },
      sniperState: 'SNIPER_WAITING',
      authBlockedAt: null,
      timing: null,
      events: [],
      updatedAt: null,
      lastPreflightSnapshot: null,
    });

  } else if (req.method === 'GET' && path === '/api/readiness') {
    // Stage 9E — Normalized readiness + confidence + armed state.
    // Stage 10A — Execution timing phase appended to response.
    // Stage 10D — Escalation record appended when click_failed has fired.
    const { loadReadiness }          = require('../bot/readiness-state');
    const { computeArmedState }      = require('../bot/armed-state');
    const { computeExecutionTiming, WARMUP_OFFSET_MS, ARMED_OFFSET_MS } = require('../scheduler/execution-timing');
    const { loadEscalations }        = require('../scheduler/escalation');
    // Stage 10F — Learned timing adjustments.
    const { getLearnedOffsets, loadLearnerSummary } = require('../scheduler/timing-learner');

    const readiness = loadReadiness();

    // Resolve the job for nextWindow + timing computation.
    // Use readiness.jobId when available, else fall back to the first active job.
    let job = null;
    try {
      const jid = readiness?.jobId ?? null;
      job = jid ? getJobById(Number(jid)) : (getAllJobs().find(j => j.is_active === 1) || null);
    } catch (_) { /* non-fatal */ }

    const armed = computeArmedState({
      readiness:       readiness || {},
      job,
      bookingActive:   jobState.active,
      schedulerPaused: isSchedulerPaused(),
    });

    // Stage 10A: compute execution timing fresh (never stale — derived from clock + job).
    // Stage 10F: apply learned timing adjustments when sufficient observations exist.
    let executionTiming = null;
    let learnedTiming   = null;
    if (job) {
      try {
        // Stage 10F — look up per-job learned offsets (null < MIN_OBS observations).
        const learned = getLearnedOffsets(job.id, { WARMUP_OFFSET_MS, ARMED_OFFSET_MS });
        if (learned) {
          learnedTiming = {
            learnedOffsetMs:      learned.learnedOffsetMs,
            adjustedArmedMs:      learned.adjustedArmedOffsetMs,
            adjustedWarmupMs:     learned.adjustedWarmupOffsetMs,
            observationCount:     learned.observationCount,
          };
        }
        executionTiming = computeExecutionTiming(job, {
          // Stage 10E — isConfirming: true while a booking run is active after opensAt.
          isConfirming: jobState.active,
          // Stage 10F — apply learned offsets when available (null = use defaults).
          warmupOffsetOverrideMs: learned?.adjustedWarmupOffsetMs ?? null,
          armedOffsetOverrideMs:  learned?.adjustedArmedOffsetMs  ?? null,
        });
      } catch (_) { /* non-fatal — job shape may be incomplete */ }
    }

    // Stage 10D: include any active escalation for the current job (null when clear).
    let escalation = null;
    try {
      const allEscalations = loadEscalations();
      const jobId = job?.id ?? readiness?.jobId ?? null;
      if (jobId != null) escalation = allEscalations[String(jobId)] ?? null;
    } catch (_) { /* non-fatal */ }

    json({ ...(readiness || {}), armed, executionTiming, learnedTiming, escalation });

  } else if (req.method === 'GET' && path === '/api/failures') {
    // Primary: query the structured failures table in SQLite.
    // Legacy fallback: scan screenshots/ for older verify-fail files not yet in DB.
    const { getRecentFailures, getFailureSummary, getFailureTrends } = require('../db/failures');
    const fsM = require('fs'), pathM = require('path');

    const dbRecent  = getRecentFailures(20);
    const dbSummary = getFailureSummary();
    const now       = Date.now();
    const trends = {
      h24: getFailureTrends({ sinceIso: new Date(now - 24 * 60 * 60 * 1000).toISOString() }),
      d7:  getFailureTrends({ sinceIso: new Date(now -  7 * 24 * 60 * 60 * 1000).toISOString() }),
    };

    // Build summary maps from DB data.
    const summaryByReason = {};
    const summaryByPhase  = {};
    for (const row of dbSummary.byReason) summaryByReason[row.reason] = row.count;
    for (const row of dbSummary.byPhase)  summaryByPhase[row.phase]   = row.count;

    // If the DB is empty, fall back to legacy filesystem scan so old screenshots still appear.
    let recent = dbRecent;
    if (dbRecent.length === 0) {
      const dir = 'screenshots';
      if (fsM.existsSync(dir)) {
        const legacyFiles = fsM.readdirSync(dir)
          .filter(n => n.endsWith('.png') && n.includes('verify-'))
          .map(name => {
            const mtime = fsM.statSync(pathM.join(dir, name)).mtimeMs;
            const m = name.match(/verify-([^.]+)\.png$/);
            const reasonTag = m ? m[1] : 'unknown';
            return {
              id:          null,
              job_id:      null,
              occurred_at: new Date(mtime).toISOString(),
              phase:       'modal_verify',
              reason:      reasonTag === 'time'            ? 'modal_time_mismatch'
                         : reasonTag === 'instructor'      ? 'modal_instructor_mismatch'
                         : reasonTag === 'time-instructor' ? 'modal_mismatch'
                         : 'unexpected_error',
              message:     null,
              class_title: null,
              screenshot:  name,
            };
          })
          .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
        recent = legacyFiles.slice(0, 5);
        for (const f of legacyFiles) summaryByReason[f.reason] = (summaryByReason[f.reason] || 0) + 1;
      }
    }

    json({ recent: recent.slice(0, 10), summary: summaryByReason, by_phase: summaryByPhase, trends });

  } else if (req.method === 'GET' && path.startsWith('/api/replay-history/')) {
    const jobId = path.split('/api/replay-history/')[1];
    if (!jobId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing jobId' }));
    } else {
      json({ runs: replayStore.getReplayList(jobId) });
    }

  } else if (req.method === 'GET' && path.startsWith('/api/replay/')) {
    // Handles both /api/replay/:jobId and /api/replay/:jobId/:runId
    const parts = path.split('/api/replay/')[1]?.split('/') ?? [];
    const jobId = parts[0];
    const runId = parts[1] ? decodeURIComponent(parts[1]) : null;

    if (!jobId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing jobId' }));
    } else {
      const replay = runId
        ? replayStore.getReplayById(jobId, runId)
        : replayStore.getLastReplay(jobId);
      if (!replay) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No replay found' }));
      } else {
        json(replay);
      }
    }

  } else if (req.method === 'GET' && path === '/api/scraped-classes') {
    const db   = openDb();
    const rows = db.prepare('SELECT * FROM scraped_classes ORDER BY day_of_week, class_time').all();
    db.close();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ classes: rows }));

  } else if (req.method === 'POST' && path === '/refresh-schedule') {
    if (_scrapeRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scrape already in progress' }));
      return;
    }
    _scrapeRunning = true;
    scrapeSchedule()
      .then(classes => {
        const db        = openDb();
        const scraped_at = new Date().toISOString();
        const replace   = db.transaction(rows => {
          db.prepare('DELETE FROM scraped_classes').run();
          const ins = db.prepare(
            'INSERT INTO scraped_classes (class_title, day_of_week, class_time, instructor, scraped_at) VALUES (?, ?, ?, ?, ?)'
          );
          for (const r of rows) {
            ins.run(r.class_title, r.day_of_week, r.class_time, r.instructor || null, scraped_at);
          }
        });
        replace(classes);
        db.close();
        _scrapeRunning = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: classes.length, scraped_at }));
      })
      .catch(err => {
        _scrapeRunning = false;
        console.error('[refresh-schedule] error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });

  } else if (req.method === 'GET' && path.startsWith('/screenshots/')) {
    // Serve screenshot images statically.
    const fsM = require('fs'), pathM = require('path');
    const file = pathM.join('screenshots', pathM.basename(path));
    if (!fsM.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    fsM.createReadStream(file).pipe(res);

  } else if (SERVE_REACT && req.method === 'GET') {
    // Serve built React assets (JS, CSS, etc.) or fall back to index.html for SPA routing.
    const safePath = pathStatic.normalize(path).replace(/^(\.\.[/\\])+/, '');
    const assetFile = pathStatic.join(DIST_DIR, safePath);
    if (!serveStatic(res, assetFile)) {
      serveStatic(res, DIST_INDEX);
    }

  } else {
    res.writeHead(404);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown — release port before exit so restarts don't hit EADDRINUSE.
// ---------------------------------------------------------------------------
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => { console.log('Server closed.'); process.exit(0); });
  setTimeout(() => { console.log('Hard exit after timeout.'); process.exit(0); }, 4000);
});

let listenAttempts = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenAttempts < 10) {
    listenAttempts++;
    console.log('Port ' + PORT + ' in use, retrying in 2s... (' + listenAttempts + '/10)');
    setTimeout(() => server.listen(PORT, HOST), 2000);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});
server.listen(PORT, HOST, () => console.log('Server running on ' + HOST + ':' + PORT));

// ---------------------------------------------------------------------------
// Built-in scheduler loop — fires a tick every 60 s so booking jobs auto-run
// when their window opens without needing a separate process.
// ---------------------------------------------------------------------------
const SCHEDULER_INTERVAL_MS = 60 * 1000;
function schedulerTick() {
  if (isSchedulerPaused()) {
    console.log('[Scheduler] paused — skipping tick');
    return;
  }
  runTick().catch(err => console.error('[Scheduler] tick error:', err.message));
  // Auto-preflight: fires before booking window at 30 min, 10 min, 2 min.
  // Runs in parallel with the tick; the jobState.active guard prevents
  // launching a browser while a booking run is already open.
  checkAutoPreflights({ isActive: jobState.active })
    .catch(err => console.error('[auto-preflight] tick error:', err.message));
  // Session keep-alive: periodic low-frequency check (default every 4 h).
  checkSessionKeepalive({ isActive: jobState.active })
    .catch(err => console.error('[session-keepalive] tick error:', err.message));
  // Background preflight loop: continuous check for jobs within 24 h of their
  // booking window (outside the 30-min zone auto-preflight already owns).
  runPreflightLoop({ isActive: jobState.active })
    .catch(err => console.error('[preflight-loop] tick error:', err.message));
}
// Delay first tick 30 s so the server is fully warm before the first run.
setTimeout(() => {
  schedulerTick();
  setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
}, 30 * 1000);
console.log(`Scheduler loop armed — ticking every ${SCHEDULER_INTERVAL_MS / 1000}s (first tick in 30s).`);
