// Web server entry point — started by Replit (npm start).
// Serves a jobs dashboard at / and booking API routes.
const http = require('http');
const { URL } = require('url');
const { getJobById, getAllJobs } = require('../db/jobs');
const { openDb } = require('../db/init');
const { runBookingJob } = require('../bot/register-pilates');

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

  const jobRowsHtml = hasJobs
    ? jobs.map(j => {
        const active = j.is_active ? '<span class="badge active">active</span>' : '<span class="badge inactive">inactive</span>';
        return `
        <tr class="job-row" data-id="${j.id}"
            data-title="${esc(j.class_title)}"
            data-day="${esc(j.day_of_week || '')}"
            data-time="${esc(j.class_time || '')}"
            data-instructor="${esc(j.instructor || '')}"
            onclick="selectJob(this)">
          <td class="job-id">#${j.id}</td>
          <td><strong>${esc(j.class_title)}</strong></td>
          <td>${esc(j.day_of_week || '—')}</td>
          <td>${esc(j.class_time  || '—')}</td>
          <td>${esc(j.instructor  || '—')}</td>
          <td>${active}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="6" class="no-jobs"><strong>No jobs found</strong>Create a test job to begin: run <code>npm run db:test</code> in the shell, then reload this page.</td></tr>';

  const sel = first
    ? `${esc(first.class_title)} · ${esc(first.day_of_week || '')} · ${esc(first.class_time || '')} · ${esc(first.instructor || '')}`
    : 'None';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YMCA Pilates — Control Panel</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #eef2f7;
      min-height: 100vh;
      padding: 24px 16px 48px;
      color: #1a1a2e;
    }

    .page {
      max-width: 640px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* ---- page header ---- */
    .page-header { text-align: center; padding: 8px 0 4px; }
    .page-header h1 { font-size: 22px; font-weight: 700; color: #1a1a2e; }
    .page-header p  { font-size: 13px; color: #888; margin-top: 4px; }

    /* ---- cards ---- */
    .card {
      background: white;
      border-radius: 14px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.07);
      overflow: hidden;
    }
    .card-header {
      padding: 14px 20px 10px;
      border-bottom: 1px solid #f0f0f0;
    }
    .card-header h2 {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #999;
    }
    .card-body { padding: 16px 20px; }

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
      font-size: 15px;
      font-weight: 600;
      color: #1a1a2e;
      line-height: 1.4;
    }
    .selected-meta {
      font-size: 13px;
      color: #666;
      margin-top: 4px;
    }

    /* ---- jobs table ---- */
    .jobs-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .jobs-table th {
      text-align: left;
      padding: 10px 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #bbb;
      border-bottom: 1px solid #f0f0f0;
    }
    .jobs-table td {
      padding: 12px 12px;
      border-bottom: 1px solid #f8f8f8;
      vertical-align: middle;
      color: #333;
    }
    .job-row { cursor: pointer; transition: background 0.15s; }
    .job-row:hover  { background: #f5f8ff; }
    .job-row.selected { background: #eef3ff; box-shadow: inset 4px 0 0 #457b9d; }
    .job-row.selected td { color: #1a1a2e; font-weight: 500; }
    .job-id { color: #bbb; font-size: 12px; font-weight: 400; }
    .no-jobs { padding: 32px 20px; text-align: center; color: #aaa; font-size: 14px; line-height: 1.6; }
    .no-jobs strong { display: block; font-size: 16px; color: #999; margin-bottom: 6px; }
    .no-jobs code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 12px; }

    /* ---- badges ---- */
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 3px 7px;
      border-radius: 20px;
    }
    .badge.active   { background: #d4edda; color: #155724; }
    .badge.inactive { background: #f0f0f0; color: #888; }

    /* ---- actions ---- */
    .actions { display: flex; flex-direction: column; gap: 10px; }
    .btn {
      border: none;
      border-radius: 10px;
      padding: 14px 20px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: opacity 0.15s, background 0.15s;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary   { background: #e63946; color: white; }
    .btn-primary:hover:not(:disabled)   { background: #c1121f; }
    .btn-secondary { background: #457b9d; color: white; }
    .btn-secondary:hover:not(:disabled) { background: #2d6080; }
    .btn-muted     { background: #f0f0f0; color: #555; }
    .btn-muted:hover:not(:disabled)     { background: #e0e0e0; }

    /* ---- status ---- */
    #status {
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      font-family: 'SF Mono', 'Fira Code', monospace;
      color: #555;
      min-height: 40px;
    }
    #status.running { color: #856404; }
    #status.success { color: #155724; }
    #status.error   { color: #721c24; }

    /* ---- spinner ---- */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block;
      width: 11px; height: 11px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
      opacity: 0.75;
    }
  </style>
</head>
<body>
  <div class="page">

    <div class="page-header">
      <h1>🧘 YMCA Pilates</h1>
      <p>Booking control panel</p>
    </div>

    <!-- Selected Job -->
    <div class="card">
      <div class="card-header"><h2>Selected Job</h2></div>
      <div class="card-body">
        <div class="selected-id"      id="sel-id">${first ? 'Job #' + first.id : ''}</div>
        <div class="selected-summary" id="sel-title">${first ? esc(first.class_title) : 'None'}</div>
        <div class="selected-meta"    id="sel-meta">${sel}</div>
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
          Register Me (Core Pilates default)
        </button>
        <button class="btn btn-muted" id="btn-clean" onclick="cleanTestJobs()">
          Clean Old Test Jobs
        </button>
      </div>
    </div>

    <!-- Status -->
    <div class="card">
      <div class="card-header"><h2>Status</h2></div>
      <div class="card-body">
        <div id="status">No job run yet.</div>
      </div>
    </div>

  </div><!-- /page -->

  <script>
    // ---- state ----
    let selectedJobId    = ${first ? first.id : 'null'};
    let selectedJobLabel = ${JSON.stringify(firstLabel)};
    let activeBtn        = null;
    let activeSuccessText = null;

    // Highlight the first row on load.
    (function() {
      const firstRow = document.querySelector('.job-row');
      if (firstRow) firstRow.classList.add('selected');
    })();

    // ---- job selection ----
    function selectJob(row) {
      document.querySelectorAll('.job-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedJobId = row.dataset.id;
      selectedJobLabel = 'Job #' + row.dataset.id + ' — ' +
        [row.dataset.title, row.dataset.day, row.dataset.time, row.dataset.instructor]
          .filter(Boolean).join(' · ');
      document.getElementById('sel-id').textContent    = 'Job #' + row.dataset.id;
      document.getElementById('sel-title').textContent = row.dataset.title;
      document.getElementById('sel-meta').textContent  =
        [row.dataset.title, row.dataset.day, row.dataset.time, row.dataset.instructor]
          .filter(Boolean).join(' · ');
    }

    // ---- spinner helper ----
    function spinnerHtml(text) {
      return '<span class="spinner"></span>' + text;
    }

    // ---- lock / unlock Run Selected Job across all runs ----
    function lockRunBtn()   {
      const b = document.getElementById('btn-run');
      if (b) { b.disabled = true; }
    }
    function unlockRunBtn() {
      const b = document.getElementById('btn-run');
      if (b && b !== activeBtn) { b.disabled = false; }
    }

    // ---- shared job runner ----
    async function startJob(url, btn, successText, statusPrefix) {
      const statusEl = document.getElementById('status');
      btn.disabled   = true;
      btn.textContent = 'Running…';
      lockRunBtn();
      statusEl.className = 'running';
      statusEl.innerHTML = spinnerHtml(statusPrefix ? statusPrefix + ' — Starting…' : 'Starting…');
      activeBtn = btn;
      activeSuccessText = successText;
      try {
        const res  = await fetch(url);
        const data = await res.json();
        if (!data.started) {
          if (data.log && data.log.includes('Already running')) {
            statusEl.innerHTML = spinnerHtml('Job already in progress — checking status…');
            poll();
          } else {
            statusEl.className   = 'error';
            statusEl.textContent = data.log || 'Could not start job.';
            btn.textContent = 'Try Again';
            btn.disabled    = false;
            unlockRunBtn();
          }
          return;
        }
        statusEl.innerHTML = spinnerHtml(statusPrefix ? statusPrefix + ' — Checking progress…' : 'Checking progress…');
        poll(statusPrefix);
      } catch (e) {
        statusEl.className   = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
        btn.textContent = 'Try Again';
        btn.disabled    = false;
        unlockRunBtn();
      }
    }

    async function poll(statusPrefix) {
      const statusEl = document.getElementById('status');
      try {
        const res  = await fetch('/status');
        const data = await res.json();
        if (data.active) {
          statusEl.innerHTML = spinnerHtml(statusPrefix ? statusPrefix + '\n' + data.log : data.log);
          setTimeout(() => poll(statusPrefix), 2000);
        } else {
          statusEl.className   = data.success ? 'success' : 'error';
          statusEl.textContent = (statusPrefix ? statusPrefix + '\n' : '') + data.log;
          if (activeBtn) {
            activeBtn.textContent = data.success ? activeSuccessText : 'Try Again';
            if (!data.success) { activeBtn.disabled = false; }
          }
          unlockRunBtn();
        }
      } catch (e) {
        statusEl.innerHTML = spinnerHtml('Checking status… (' + e.message + ')');
        setTimeout(() => poll(statusPrefix), 3000);
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
        '✅ Done!',
        'Running ' + selectedJobLabel
      );
    }

    function runRegister() {
      startJob('/register', document.getElementById('btn-register'), '✅ Registered!', 'Running Core Pilates (default)');
    }

    async function cleanTestJobs() {
      const btn = document.getElementById('btn-clean');
      const statusEl = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Cleaning…';
      statusEl.className = 'running';
      statusEl.innerHTML = spinnerHtml('Cleaning old test jobs…');
      try {
        const res  = await fetch('/clean-test-jobs');
        const data = await res.json();
        statusEl.textContent = data.log;
        statusEl.className   = data.success ? 'success' : 'error';
      } catch (e) {
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
