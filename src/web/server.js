// Web server entry point — started by Replit (npm start).
// Serves a jobs dashboard at / and booking API routes.
const http = require('http');
const { URL } = require('url');
const { getJobById, getAllJobs, createJob, updateJob, deleteJob, setJobActive, setLastRun } = require('../db/jobs');
const { openDb } = require('../db/init');
const { runBookingJob } = require('../bot/register-pilates');
const { getDryRun, setDryRun } = require('../bot/dry-run-state');
const { getPhase }           = require('../scheduler/booking-window');
const { setSchedulerPaused, isSchedulerPaused } = require('../scheduler/scheduler-state');
const { runTick }            = require('../scheduler/tick');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

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
  const { phase: firstPhase, bookingOpenMs: firstBookingOpenMs } =
    first ? jobInfo(first) : { phase: 'unknown', bookingOpenMs: null };

  /* Mobile job cards — same data-attributes as table rows so selectJob() works */
  const mobileJobCardsHtml = hasJobs
    ? jobs.map(j => {
        const { phase, bookingOpenMs } = jobInfo(j);
        const jobBooked = isBookedSS(j);
        const isFirst   = first && j.id === first.id;
        return `<div class="mobile-job-card${isFirst ? ' selected' : ''}"
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
            ${jobBooked ? '<span class="badge-booked">\u2713\u00a0Booked</span>' : ''}
            ${j.last_result ? `<span class="badge badge-result-${j.last_result}">${j.last_result}</span>` : ''}
          </div>
        </div>`;
      }).join('')
    : '<div style="padding:20px;color:#aaa;font-size:14px;text-align:center;">No jobs found.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>YMCA BOT \u2014 Control Panel</title>
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
      display: inline-flex;
      align-items: center;
      gap: 6px;
      opacity: 0;
      pointer-events: none;
      margin-top: 8px;
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

      /* ---- More Actions button (mobile) ---- */
      .mobile-more-btn { display: block !important; }
    }

    /* Desktop: hide mobile cards and More Actions button */
    @media (min-width: 641px) {
      .mobile-jobs-card  { display: none !important; }
      .mobile-more-btn   { display: none !important; }
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

    /* ================================================================
       MOBILE MODE SYSTEM  (Normal / Focus / StandBy)
       ================================================================ */
    @media (max-width: 768px) {
      /* Sections hidden by the JS mode controller */
      .mobile-section-hidden { display: none !important; }

      /* Mode switcher card — visible at full mobile width */
      #mode-switcher { display: block !important; }

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

      /* Mode switcher — segmented control */
      .mode-seg {
        display: flex;
        background: #f0f4f8;
        border-radius: 11px;
        padding: 3px;
        gap: 2px;
      }
      .mode-seg-btn {
        flex: 1;
        border: none;
        background: transparent;
        border-radius: 9px;
        padding: 10px 8px;
        font-size: 13px;
        font-weight: 600;
        color: #aaa;
        cursor: pointer;
        transition: background 0.15s, color 0.15s, box-shadow 0.15s;
        letter-spacing: -0.01em;
      }
      .mode-seg-btn.active {
        background: white;
        color: #1a1a2e;
        box-shadow: 0 1px 5px rgba(0,0,0,0.13);
      }
      .mode-seg-btn:active:not(.active) { background: rgba(0,0,0,0.04); }

      /* Focus mode: slightly larger countdown */
      body.mode-focus .selected-job-card .sel-countdown { font-size: 18px; color: #555; }

      /* StandBy mode: hero card gets bigger type + generous spacing */
      body.mode-standby .selected-job-card .selected-summary { font-size: 22px; }
      body.mode-standby .selected-job-card .selected-id      { font-size: 13px; }
      body.mode-standby .selected-job-card .sel-countdown {
        font-size: 32px;
        font-weight: 700;
        color: #1a1a2e;
        margin-top: 18px;
        letter-spacing: -1px;
      }
      body.mode-standby .selected-job-card .card-body         { padding: 28px 20px 32px; }
      body.mode-standby .selected-job-card .selected-run-info { font-size: 12px; margin-top: 14px; }
      /* StandBy: sticky run bar collapses to single full-width button */
      body.mode-standby #sticky-run-bar .srb-secondary { display: none !important; }
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

  <div class="main-container">
  <div class="page">

    <div class="page-header">
      <h1>&#x1F9D8; YMCA BOT</h1>
      <p>Booking control panel</p>
    </div>
    <div id="live-mode-indicator">&#x1F680; Live Mode Active</div>

    <!-- Mobile mode switcher: Normal / Focus / StandBy (hidden on desktop) -->
    <div id="mode-switcher" class="card mobile-only">
      <div class="card-body" style="padding:12px 14px">
        <div class="mode-seg">
          <button class="mode-seg-btn" data-mode="normal"  onclick="setMobileMode('normal')">Normal</button>
          <button class="mode-seg-btn" data-mode="focus"   onclick="setMobileMode('focus')">Focus</button>
          <button class="mode-seg-btn" data-mode="standby" onclick="setMobileMode('standby')">StandBy</button>
        </div>
      </div>
    </div>

    <div id="next-job-banner" class="banner hidden" data-mobile-section="banner"></div>

    <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;">
      <span id="dry-run-indicator" class="${dryRunEnabled ? 'mode-dry' : 'mode-live'}">${dryRunEnabled ? '&#x1F9EA; Dry Run' : '&#x1F680; Live'}</span>
      <div id="scheduler-status" class="scheduler-status" style="margin:0">&#9654; Scheduler running</div>
    </div>

    <!-- Selected Job -->
    <div class="card selected-job-card">
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
    <div class="card mobile-jobs-card" data-mobile-section="jobs">
      <div class="card-header"><h2>Jobs</h2></div>
      <div id="mobile-jobs-list">${mobileJobCardsHtml}</div>
    </div>

    <!-- Actions -->
    <div class="card" data-mobile-section="actions">
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
    <div class="card" data-mobile-section="forms">
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
    <div class="card" data-mobile-section="forms">
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

    <!-- Status -->
    <div class="card" data-mobile-section="status">
      <div class="card-header"><h2>Status</h2></div>
      <div class="card-body status-body">
        <div id="status">Ready to run ${first ? 'Job #' + first.id : 'a job'}.</div>
        <div class="last-run" id="last-run" style="display:none"></div>
      </div>
    </div>

    <div class="card" data-mobile-section="debug">
      <div class="card-header"><h2>Failure Summary</h2></div>
      <div class="card-body">
        <div id="failure-summary"><span id="failure-summary-empty">No failures recorded.</span></div>
      </div>
    </div>

    <div class="card" data-mobile-section="debug">
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

    function triggerSuccessPulse() {
      var el = document.getElementById('sel-success-pulse');
      if (!el) return;
      el.classList.remove('active');
      void el.offsetWidth;
      el.classList.add('active');
    }

    function triggerUnifiedSuccess() {
      if (navigator.vibrate) navigator.vibrate(10);
      requestAnimationFrame(function() {
        triggerFlash();
        triggerBounce();
        triggerCheckmark();
        triggerSuccessPulse();
      });
    }

    // ---- dry run toggle ----

    function updateDryRunUI(enabled) {
      const ind  = document.getElementById('dry-run-indicator');
      const live = document.getElementById('live-mode-indicator');
      ind.textContent  = enabled ? '\u{1F9EA} Dry Run' : '\u{1F680} Live';
      ind.className    = enabled ? 'mode-dry' : 'mode-live';
      document.body.classList.toggle('live-mode', !enabled);
      live.classList.toggle('visible', !enabled);
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

    // ---- Mobile mode system (Normal / Focus / StandBy) ----
    // Sections: banner, jobs, actions, forms, status, debug.
    // 'selected' and 'header' sections are always visible on mobile.
    var MOBILE_MODE_SECTIONS = {
      normal:  { banner:true,  jobs:true,  actions:true,  forms:true,  status:true,  debug:true  },
      focus:   { banner:true,  jobs:false, actions:true,  forms:false, status:true,  debug:false },
      standby: { banner:false, jobs:false, actions:false, forms:false, status:false, debug:false },
    };

    function applyMobileMode(mode) {
      if (!mode || !MOBILE_MODE_SECTIONS[mode]) mode = 'normal';
      document.body.classList.remove('mode-normal', 'mode-focus', 'mode-standby');
      document.body.classList.add('mode-' + mode);
      var vis = MOBILE_MODE_SECTIONS[mode];
      document.querySelectorAll('[data-mobile-section]').forEach(function(el) {
        var sec = el.dataset.mobileSection;
        if (sec === 'selected' || sec === 'header') {
          el.classList.remove('mobile-section-hidden');
        } else {
          var show = vis[sec] !== false;
          el.classList.toggle('mobile-section-hidden', !show);
        }
      });
      document.querySelectorAll('.mode-seg-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      });
    }

    function setMobileMode(mode) {
      try { localStorage.setItem('mobileMode', mode); } catch(e) {}
      applyMobileMode(mode);
    }

    // Restore mode on load
    (function() {
      var saved = 'normal';
      try { saved = localStorage.getItem('mobileMode') || 'normal'; } catch(e) {}
      applyMobileMode(saved);
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
    const jobs      = getAllJobs();
    const error     = parsed.searchParams.get('error')      || null;
    const editError = parsed.searchParams.get('edit_error') || null;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildHtml(jobs, error, editError));

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
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const fields = {};
      body.split('&').forEach(pair => {
        const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
        if (k) fields[k] = (v || '').trim();
      });
      const id         = parseInt(fields.job_id, 10);
      const classTitle = fields.title      || '';
      const dayOfWeek  = fields.day        || '';
      const classTime  = fields.time       || '';
      const instructor = fields.instructor || '';
      const targetDate = fields.target_date || null;

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
    });

  } else if (req.method === 'POST' && path === '/toggle-active') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const fields = {};
      body.split('&').forEach(pair => {
        const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
        if (k) fields[k] = (v || '').trim();
      });
      const id       = parseInt(fields.job_id, 10);
      const isActive = fields.is_active === '1';
      if (id) {
        setJobActive(id, isActive);
        console.log(`Set job #${id} is_active=${isActive}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

  } else if (req.method === 'POST' && path === '/delete-job') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const fields = {};
      body.split('&').forEach(pair => {
        const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
        if (k) fields[k] = (v || '').trim();
      });
      const id = parseInt(fields.job_id, 10);
      if (id) {
        deleteJob(id);
        console.log(`Deleted job #${id} via web UI`);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

  } else if (req.method === 'POST' && path === '/add-job') {
    // Collect the POST body (URL-encoded form data).
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      // Parse "key=value&key=value" without external libraries.
      const fields = {};
      body.split('&').forEach(pair => {
        const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
        if (k) fields[k] = (v || '').trim();
      });

      const classTitle = fields.title      || '';
      const dayOfWeek  = fields.day        || '';
      const classTime  = fields.time       || '';
      const instructor = fields.instructor || '';
      const targetDate = fields.target_date || null;

      // Validate required fields — same rules as the CLI script.
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

  } else if (req.method === 'GET' && path === '/api/failures') {
    // Return last 5 verify-fail screenshots + grouped counts across all verify-fails.
    const fsM = require('fs'), pathM = require('path'), dir = 'screenshots';
    if (!fsM.existsSync(dir)) { json({ recent: [], summary: {} }); return; }
    const all = fsM.readdirSync(dir)
      .filter(n => n.endsWith('.png') && n.includes('verify-'))
      .map(name => {
        const mtime = fsM.statSync(pathM.join(dir, name)).mtimeMs;
        const m = name.match(/verify-([^.]+)\.png$/);
        const metaPath = pathM.join(dir, name.replace('.png', '.json'));
        let meta = {};
        try { if (fsM.existsSync(metaPath)) meta = JSON.parse(fsM.readFileSync(metaPath, 'utf8')); } catch (_) {}
        return { name, mtime, reason: m ? m[1] : 'unknown', meta };
      })
      .sort((a, b) => b.mtime - a.mtime);
    // Grouped counts over all verify-fail files (not just top 5).
    const summary = {};
    for (const f of all) { summary[f.reason] = (summary[f.reason] || 0) + 1; }
    json({ recent: all.slice(0, 5), summary });

  } else if (req.method === 'GET' && path.startsWith('/screenshots/')) {
    // Serve screenshot images statically.
    const fsM = require('fs'), pathM = require('path');
    const file = pathM.join('screenshots', pathM.basename(path));
    if (!fsM.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    fsM.createReadStream(file).pipe(res);

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
}
// Delay first tick 30 s so the server is fully warm before the first run.
setTimeout(() => {
  schedulerTick();
  setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
}, 30 * 1000);
console.log(`Scheduler loop armed — ticking every ${SCHEDULER_INTERVAL_MS / 1000}s (first tick in 30s).`);
