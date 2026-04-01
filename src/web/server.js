// Web server entry point — started by Replit (npm start).
// Serves a jobs dashboard at / and booking API routes.
const http = require('http');
const { URL } = require('url');
const { getJobById, getAllJobs, createJob, updateJob, deleteJob, setJobActive, setLastRun } = require('../db/jobs');
const { openDb } = require('../db/init');
const { runBookingJob } = require('../bot/register-pilates');
const { getPhase } = require('../scheduler/booking-window');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// ---------------------------------------------------------------------------
// HTML builder — generates the full page with jobs injected server-side.
// ---------------------------------------------------------------------------
function buildHtml(jobs, error, editError) {
  const hasJobs = jobs && jobs.length > 0;
  const first   = hasJobs ? jobs[0] : null;
  const firstLabel = first
    ? `Job #${first.id} \u2014 ${first.class_title} \u00b7 ${first.day_of_week || ''} \u00b7 ${first.class_time || ''} \u00b7 ${first.instructor || ''}`
    : null;

  // Compute booking phase for each job (server-side, using scheduler module).
  function jobPhase(j) {
    try { return getPhase(j).phase; } catch(e) { return 'unknown'; }
  }

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
        const phase         = jobPhase(j);
        const phaseBadge    = '<span class="badge badge-phase-' + phase + '">' + (PHASE_LABEL[phase] || phase) + '</span>';
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
            onclick="selectJob(this)">
          <td class="job-id">#${j.id}</td>
          <td><span class="dot ${j.is_active ? 'dot-on' : 'dot-off'}" title="${j.is_active ? 'Active' : 'Inactive'}"></span><strong>${esc(j.class_title)}</strong>${j.last_result === 'error' && j.last_error_message ? ` <span class="row-warn" title="${esc(j.last_error_message)}">&#9888;</span>` : ''}</td>
          <td>${esc(j.day_of_week  || '\u2014')}</td>
          <td>${esc(j.class_time   || '\u2014')}</td>
          <td>${esc(j.target_date  || '\u2014')}</td>
          <td>${esc(j.instructor   || '\u2014')}</td>
          <td>${phaseBadge}</td>
          <td class="col-last-run">${lastRunCell}</td>
          <td>${lastResBadge}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="9" class="no-jobs"><strong>No jobs found</strong>Create a test job to begin: run <code>npm run db:test</code> in the shell, then reload this page.</td></tr>';

  const sel = first
    ? `${esc(first.class_title)} \u00b7 ${esc(first.day_of_week || '')} \u00b7 ${esc(first.class_time || '')} \u00b7 ${esc(first.instructor || '')}`
    : 'None';
  const firstPhase = first ? jobPhase(first) : 'unknown';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YMCA Pilates \u2014 Control Panel</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #eef2f7;
      min-height: 100vh;
      padding: 28px 16px 56px;
      color: #1a1a2e;
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

    /* ---- cards ---- */
    .card {
      background: white;
      border-radius: 14px;
      box-shadow: 0 2px 14px rgba(0,0,0,0.07);
      overflow: hidden;
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
    }
    #status.running { color: #856404; }
    #status.success { color: #155724; }
    #status.error   { color: #721c24; }
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
  </style>
</head>
<body>
  <div class="page">

    <div class="page-header">
      <h1>&#x1F9D8; YMCA Pilates</h1>
      <p>Booking control panel</p>
    </div>

    <!-- Selected Job -->
    <div class="card">
      <div class="card-header"><h2>Selected Job</h2></div>
      <div class="card-body">
        <div class="selected-id"      id="sel-id">${first ? 'Job #' + first.id : ''}</div>
        <div class="selected-summary" id="sel-title">${first ? esc(first.class_title) : 'None'}</div>
        <div class="selected-meta"    id="sel-meta">${sel}</div>
        <div class="selected-date"    id="sel-date" style="font-size:13px;color:#888;margin-top:4px;">Date: <strong>${first && first.target_date ? esc(first.target_date) : '\u2014'}</strong></div>
        <div class="selected-phase"   id="sel-phase"><span class="badge badge-phase-${firstPhase}">${PHASE_LABEL[firstPhase] || firstPhase}</span></div>
        <div id="sel-booked-box" class="sel-booked-box" ${firstIsBooked ? '' : 'style="display:none"'}>
          <span class="booked-icon">&#10003;</span>
          <span id="sel-booked-text">${first && first.target_date ? `Booked for ${esc(first.target_date)}` : 'Booked this week'}</span>
        </div>
        <div class="selected-run-info">
          <span class="run-label">Last run:</span>
          <span id="sel-last-run">${first ? fmtRunAt(first.last_run_at) : 'Never'}</span>
          &nbsp;&middot;&nbsp;
          <span class="run-label">Result:</span>
          <span id="sel-last-result">${first ? resultBadge(first.last_result) : resultBadge(null)}</span>
        </div>
        ${first && first.last_result === 'error' && first.last_error_message
          ? `<div class="sel-error-box" id="sel-error-box"><span class="err-label">Last Error</span>${esc(first.last_error_message)}</div>`
          : `<div class="sel-error-box" id="sel-error-box" style="display:none"><span class="err-label">Last Error</span><span id="sel-error-text"></span></div>`
        }
      </div>
    </div>

    <!-- Saved Jobs -->
    <div class="card">
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
            </tr>
          </thead>
          <tbody id="jobs-body">
            ${jobRowsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Actions -->
    <div class="card">
      <div class="card-header"><h2>Actions</h2></div>
      <div class="card-body actions">
        <button class="btn btn-primary" id="btn-run" onclick="runSelected()">
          Run Selected Job
        </button>
        <button class="btn btn-secondary" id="btn-register" onclick="runRegister()">
          Run Default Job
        </button>
        <button class="btn btn-muted" id="btn-clean" onclick="cleanTestJobs()">
          Clean Old Test Jobs
        </button>
        <button class="btn btn-toggle ${first && !first.is_active ? '' : 'is-active'}" id="btn-toggle" onclick="toggleActive()">
          ${first ? (first.is_active ? 'Deactivate Job' : 'Activate Job') : 'Toggle Active'}
        </button>
        <button class="btn btn-danger" id="btn-delete" onclick="deleteSelectedJob()">
          Delete Job
        </button>
      </div>
    </div>

    <!-- Create Job -->
    <div class="card">
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
    <div class="card">
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
    <div class="card">
      <div class="card-header"><h2>Status</h2></div>
      <div class="card-body status-body">
        <div id="status">Ready to run ${first ? 'Job #' + first.id : 'a job'}.</div>
        <div class="last-run" id="last-run" style="display:none"></div>
      </div>
    </div>

  </div><!-- /page -->

  <script>
    // ---- state ----
    let selectedJobId         = ${first ? first.id : 'null'};
    let selectedJobLabel      = ${JSON.stringify(firstLabel)};
    let selectedJobPhase      = ${JSON.stringify(firstPhase)};
    let selectedJobLastRunAt  = ${JSON.stringify(first ? (first.last_run_at  || '') : '')};
    let selectedJobLastResult = ${JSON.stringify(first ? (first.last_result  || '') : '')};
    let selectedJobTargetDate = ${JSON.stringify(first ? (first.target_date  || '') : '')};
    let selectedJobIsActive    = ${first ? (first.is_active ? 'true' : 'false') : 'true'};
    let selectedJobLastSuccessAt = ${JSON.stringify(first ? (first.last_success_at || '') : '')};
    let selectedJobLastErrMsg  = ${JSON.stringify(first && first.last_result === 'error' ? (first.last_error_message || '') : '')};
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

    // Highlight the first row on load.
    (function() {
      const firstRow = document.querySelector('.job-row');
      if (firstRow) firstRow.classList.add('selected');
    })();

    // ---- job selection ----
    function selectJob(row) {
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
      selectedJobId         = row.dataset.id;
      selectedJobPhase      = row.dataset.phase      || 'unknown';
      selectedJobLastRunAt  = row.dataset.lastRunAt  || '';
      selectedJobLastResult = row.dataset.lastResult || '';
      selectedJobTargetDate = row.dataset.targetDate || '';
      selectedJobIsActive      = row.dataset.isActive      === '1';
      selectedJobLastSuccessAt = row.dataset.lastSuccessAt  || '';
      selectedJobLastErrMsg    = row.dataset.lastErrorMsg   || '';
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

      // Show or hide the error message box
      const errBox = document.getElementById('sel-error-box');
      if (errBox) {
        const errText = document.getElementById('sel-error-text');
        if (selectedJobLastResult === 'error' && selectedJobLastErrMsg) {
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

      // Update Toggle Active button label + style
      const toggleBtn = document.getElementById('btn-toggle');
      if (toggleBtn) {
        toggleBtn.textContent = selectedJobIsActive ? 'Deactivate Job' : 'Activate Job';
        toggleBtn.classList.toggle('is-active', selectedJobIsActive);
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
          statusEl.className   = data.success ? 'success' : 'error';
          statusEl.textContent = prefix + data.log;
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

    function runSelected() {
      if (!selectedJobId) {
        const statusEl = document.getElementById('status');
        statusEl.className   = 'error';
        statusEl.textContent = 'No job selected. Click a row in the Saved Jobs table first.';
        return;
      }
      startJob(
        '/run-job?id=' + selectedJobId,
        document.getElementById('btn-run'),
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
  runBookingJob(job)
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
