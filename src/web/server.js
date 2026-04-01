// Web server entry point — started by Replit (npm start).
// Serves a jobs dashboard at / and booking API routes.
const http = require('http');
const { URL } = require('url');
const { getJobById, getAllJobs } = require('../db/jobs');
const { openDb } = require('../db/init');
const { runBookingJob } = require('../bot/register-pilates');
const { getPhase } = require('../scheduler/booking-window');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// ---------------------------------------------------------------------------
// HTML builder — generates the full page with jobs injected server-side.
// ---------------------------------------------------------------------------
function buildHtml(jobs) {
  const hasJobs = jobs && jobs.length > 0;
  const first   = hasJobs ? jobs[0] : null;
  const firstLabel = first
    ? `Job #${first.id} \u2014 ${first.class_title} \u00b7 ${first.day_of_week || ''} \u00b7 ${first.class_time || ''} \u00b7 ${first.instructor || ''}`
    : null;

  // Compute booking phase for each job (server-side, using scheduler module).
  function jobPhase(j) {
    try { return getPhase(j).phase; } catch(e) { return 'unknown'; }
  }

  const PHASE_LABEL = {
    too_early: 'Too Early',
    warmup:    'Warmup',
    sniper:    'Sniper',
    late:      'Open',
    unknown:   'Unknown',
  };

  const jobRowsHtml = hasJobs
    ? jobs.map(j => {
        const phase  = jobPhase(j);
        const active = j.is_active
          ? '<span class="badge badge-active">active</span>'
          : '<span class="badge badge-inactive">inactive</span>';
        const phaseBadge = `<span class="badge badge-phase-${phase}">${PHASE_LABEL[phase] || phase}</span>`;
        return `
        <tr class="job-row"
            data-id="${j.id}"
            data-title="${esc(j.class_title)}"
            data-day="${esc(j.day_of_week || '')}"
            data-time="${esc(j.class_time || '')}"
            data-instructor="${esc(j.instructor || '')}"
            data-phase="${esc(phase)}"
            onclick="selectJob(this)">
          <td class="job-id">#${j.id}</td>
          <td><strong>${esc(j.class_title)}</strong></td>
          <td>${esc(j.day_of_week || '\u2014')}</td>
          <td>${esc(j.class_time  || '\u2014')}</td>
          <td>${esc(j.instructor  || '\u2014')}</td>
          <td>${phaseBadge}</td>
          <td>${active}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="7" class="no-jobs"><strong>No jobs found</strong>Create a test job to begin: run <code>npm run db:test</code> in the shell, then reload this page.</td></tr>';

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
    .jobs-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .jobs-table th {
      text-align: left;
      padding: 11px 14px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #bbb;
      border-bottom: 1px solid #f0f0f0;
    }
    .jobs-table td {
      padding: 13px 14px;
      border-bottom: 1px solid #f8f8f8;
      vertical-align: middle;
      color: #333;
    }
    .job-row { cursor: pointer; transition: background 0.15s; }
    .job-row:hover  { background: #f5f8ff; }
    .job-row.selected { background: #eef3ff; box-shadow: inset 4px 0 0 #457b9d; }
    .job-row.selected td { color: #1a1a2e; font-weight: 500; }
    .job-id { color: #bbb; font-size: 12px; font-weight: 400; }
    .no-jobs { padding: 36px 24px; text-align: center; color: #aaa; font-size: 14px; line-height: 1.7; }
    .no-jobs strong { display: block; font-size: 16px; color: #999; margin-bottom: 8px; }
    .no-jobs code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 12px; }

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
        <div class="selected-phase"   id="sel-phase"><span class="badge badge-phase-${firstPhase}">${PHASE_LABEL[firstPhase] || firstPhase}</span></div>
      </div>
    </div>

    <!-- Saved Jobs -->
    <div class="card">
      <div class="card-header"><h2>Saved Jobs</h2></div>
      <table class="jobs-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Class</th>
            <th>Day</th>
            <th>Time</th>
            <th>Instructor</th>
            <th>Phase</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="jobs-body">
          ${jobRowsHtml}
        </tbody>
      </table>
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
      </div>
    </div>

    <!-- Status -->
    <div class="card">
      <div class="card-header"><h2>Status</h2></div>
      <div class="card-body status-body">
        <div id="status">No job run yet.</div>
        <div class="last-run" id="last-run" style="display:none"></div>
      </div>
    </div>

  </div><!-- /page -->

  <script>
    // ---- state ----
    let selectedJobId    = ${first ? first.id : 'null'};
    let selectedJobLabel = ${JSON.stringify(firstLabel)};
    let selectedJobPhase = ${JSON.stringify(firstPhase)};
    let activeBtn        = null;
    let activeSuccessText = null;
    let dotsTimer        = null;

    const PHASE_LABEL = ${JSON.stringify(PHASE_LABEL)};

    // Highlight the first row on load.
    (function() {
      const firstRow = document.querySelector('.job-row');
      if (firstRow) firstRow.classList.add('selected');
    })();

    // ---- job selection ----
    function selectJob(row) {
      document.querySelectorAll('.job-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedJobId    = row.dataset.id;
      selectedJobPhase = row.dataset.phase || 'unknown';
      selectedJobLabel = 'Job #' + row.dataset.id + ' \u2014 ' +
        [row.dataset.title, row.dataset.day, row.dataset.time, row.dataset.instructor]
          .filter(Boolean).join(' \u00b7 ');
      document.getElementById('sel-id').textContent    = 'Job #' + row.dataset.id;
      document.getElementById('sel-title').textContent = row.dataset.title;
      document.getElementById('sel-meta').textContent  =
        [row.dataset.title, row.dataset.day, row.dataset.time, row.dataset.instructor]
          .filter(Boolean).join(' \u00b7 ');
      const ph = selectedJobPhase;
      document.getElementById('sel-phase').innerHTML =
        '<span class="badge badge-phase-' + ph + '">' + (PHASE_LABEL[ph] || ph) + '</span>';
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
            btn.textContent = 'Try Again';
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
        btn.textContent = 'Try Again';
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
            activeBtn.textContent = data.success ? activeSuccessText : 'Try Again';
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
    })
    .catch(err => {
      jobState = { active: false, log: 'Error: ' + err.message, success: false };
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
    const jobs = getAllJobs();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildHtml(jobs));

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
      classTitle:  dbJob.class_title,
      classTime:   dbJob.class_time,
      dayOfWeek:   dbJob.day_of_week,
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
