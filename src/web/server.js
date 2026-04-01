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
    async function register() {
      const btn = document.getElementById('btn');
      const status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Running...';
      status.className = 'running';
      status.style.display = 'block';
      status.textContent = 'Starting registration...';

      try {
        const res = await fetch('/register');
        const data = await res.json();
        status.textContent = data.log;
        if (data.success) {
          status.className = 'success';
          btn.textContent = '✅ Registered!';
        } else {
          status.className = 'error';
          btn.textContent = 'Try Again';
          btn.disabled = false;
        }
      } catch (e) {
        status.className = 'error';
        status.textContent = 'Network error: ' + e.message;
        btn.textContent = 'Try Again';
        btn.disabled = false;
      }
    }

    async function runFromDb() {
      const btn = document.getElementById('btn2');
      const status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Running...';
      status.className = 'running';
      status.style.display = 'block';
      status.textContent = 'Loading job from database...';

      try {
        const res = await fetch('/run-job');
        const data = await res.json();
        status.textContent = data.log;
        if (data.success) {
          status.className = 'success';
          btn.textContent = '✅ Done!';
        } else {
          status.className = 'error';
          btn.textContent = 'Try Again';
          btn.disabled = false;
        }
      } catch (e) {
        status.className = 'error';
        status.textContent = 'Network error: ' + e.message;
        btn.textContent = 'Try Again';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

let running = false;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (req.method === 'GET' && req.url === '/register') {
    if (running) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, log: 'Already running, please wait...' }));
      return;
    }
    running = true;
    try {
      const result = await runBookingJob({ classTitle: 'Core Pilates' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: result.status === 'success', log: result.message }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, log: 'Server error: ' + err.message }));
    } finally {
      running = false;
    }
  } else if (req.method === 'GET' && req.url === '/run-job') {
    // Load job id 1 from DB and run the bot using that data
    const dbJob = getJobById(1);
    if (!dbJob) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, log: 'No job found in database. Run: npm run db:test' }));
      return;
    }
    if (running) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, log: 'Already running, please wait...' }));
      return;
    }
    running = true;
    try {
      const job = { classTitle: dbJob.class_title };
      console.log('Running job from DB:', job);
      const result = await runBookingJob(job);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: result.status === 'success', log: result.message }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, log: 'Server error: ' + err.message }));
    } finally {
      running = false;
    }
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

server.listen(PORT, HOST, () => console.log('Server running on ' + HOST + ':' + PORT));
