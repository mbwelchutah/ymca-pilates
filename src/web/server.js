// Web server entry point — started by Replit (npm start) and the deployment run command.
// Serves a one-button UI at / and a /register endpoint that triggers the
// Playwright booking automation in the same process.
const http = require('http');
const { getJobById } = require('../db/jobs');
const { runBookingJob } = require('../bot/register-pilates');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

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
    <button id="btn2" onclick="runFromDb()" style="margin-top: 12px; background: #457b9d;">Run Saved Job</button>
    <div id="status"></div>
  </div>
  <script>
    let activeBtn = null;
    let activeSuccessText = null;

    async function startJob(url, btn, successText) {
      const statusEl = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Running...';
      statusEl.className = 'running';
      statusEl.style.display = 'block';
      statusEl.textContent = 'Starting...';
      activeBtn = btn;
      activeSuccessText = successText;
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!data.started) {
          statusEl.className = 'error';
          statusEl.textContent = data.log || 'Could not start job.';
          btn.textContent = 'Try Again';
          btn.disabled = false;
          return;
        }
        statusEl.textContent = 'Job started — checking progress...';
        poll();
      } catch (e) {
        statusEl.className = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
        btn.textContent = 'Try Again';
        btn.disabled = false;
      }
    }

    async function poll() {
      const statusEl = document.getElementById('status');
      try {
        const res = await fetch('/status');
        const data = await res.json();
        statusEl.textContent = data.log;
        if (data.active) {
          setTimeout(poll, 2000);
        } else {
          if (data.success) {
            statusEl.className = 'success';
            if (activeBtn) activeBtn.textContent = activeSuccessText;
          } else {
            statusEl.className = 'error';
            if (activeBtn) { activeBtn.textContent = 'Try Again'; activeBtn.disabled = false; }
          }
        }
      } catch (e) {
        statusEl.textContent = 'Checking status... (' + e.message + ')';
        setTimeout(poll, 3000);
      }
    }

    function register() { startJob('/register', document.getElementById('btn'), '✅ Registered!'); }
    function runFromDb() { startJob('/run-job', document.getElementById('btn2'), '✅ Done!'); }
  </script>
</body>
</html>`;

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

const server = http.createServer(async (req, res) => {
  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);

  } else if (req.method === 'GET' && req.url === '/status') {
    json(jobState);

  } else if (req.method === 'GET' && req.url === '/register') {
    if (jobState.active) { json({ started: false, log: 'Already running, please wait...' }); return; }
    runInBackground({ classTitle: 'Core Pilates' });
    json({ started: true });

  } else if (req.method === 'GET' && req.url === '/run-job') {
    if (jobState.active) { json({ started: false, log: 'Already running, please wait...' }); return; }
    const dbJob = getJobById(1);
    if (!dbJob) { json({ started: false, log: 'No job found in database. Run: npm run db:test' }); return; }
    console.log('Running job from DB:', dbJob.class_title);
    runInBackground({ classTitle: dbJob.class_title });
    json({ started: true });

  } else {
    res.writeHead(404);
    res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' already in use — kill the stale process and retry');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown on SIGTERM (sent by Replit when restarting the workflow).
// Calling server.close() releases the port before the process exits, preventing
// EADDRINUSE on the next start.
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Hard exit if close() stalls (e.g. a long-running Playwright job)
  setTimeout(() => process.exit(0), 5000).unref();
});

server.listen(PORT, HOST, () => console.log('Server running on ' + HOST + ':' + PORT));
