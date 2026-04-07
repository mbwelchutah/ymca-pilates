// Tier-2: lightweight HTTP session validation (no browser needed).
//
// After a Playwright-based auth succeeds, browser cookies are saved to disk via
// saveCookies().  pingSessionHttp() then uses those saved cookies to make fast
// authenticated HTTP requests to Daxko and FamilyWorks, verifying the sessions
// are still alive without launching a browser.
//
// On success: both session-status.json and familyworks-session.json get fresh
// checkedAt timestamps so the next keepalive's Tier-1 check will pass.
//
// Requires Node.js ≥ 18 (native fetch).

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.resolve(__dirname, '../data');
const COOKIES_FILE = path.join(DATA_DIR, 'session-cookies.json');
const STATUS_FILE  = path.join(DATA_DIR, 'session-status.json');
const FW_FILE      = path.join(DATA_DIR, 'familyworks-session.json');

const PING_TIMEOUT_MS = 10000;

// Daxko: an authenticated page. With valid cookies it returns 200.
// With an expired session it redirects (302) to find_account / login.
const DAXKO_PING_URL  = 'https://operations.daxko.com/Online/MyAccountV2.mvc';

// FamilyWorks (Bubble.io): GET /api/1.1/obj/user returns
//   { status: 'success', response: { ... } } when authenticated,
//   { status: 'error',   message: 'Unauthorized' }  (or HTTP 401) when not.
const FW_PING_URL = 'https://my.familyworks.app/api/1.1/obj/user';

// ── Cookie persistence ────────────────────────────────────────────────────────

function saveCookies(cookies) {
  try {
    if (!Array.isArray(cookies) || cookies.length === 0) return;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = { savedAt: new Date().toISOString(), cookies };
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(payload, null, 2));
    console.log(`[session-ping] Saved ${cookies.length} cookies for Tier-2 ping.`);
  } catch (e) {
    console.warn('[session-ping] saveCookies failed:', e.message);
  }
}

function loadCookies() {
  try {
    if (!fs.existsSync(COOKIES_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    return Array.isArray(raw?.cookies) && raw.cookies.length > 0 ? raw.cookies : null;
  } catch {
    return null;
  }
}

// Build a Cookie header string for the cookies relevant to a target domain.
// Playwright stores domains with an optional leading dot (e.g. ".daxko.com").
function cookieHeader(cookies, targetDomain) {
  return cookies
    .filter(c => {
      const d = c.domain.replace(/^\./, '');
      return targetDomain === d || targetDomain.endsWith('.' + d);
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Daxko ping ────────────────────────────────────────────────────────────────

async function pingDaxko(cookies) {
  try {
    const cookie = cookieHeader(cookies, 'operations.daxko.com');
    const res = await fetchWithTimeout(DAXKO_PING_URL, {
      method:   'GET',
      headers:  { Cookie: cookie, 'User-Agent': 'Mozilla/5.0 (compatible; YMCA-Bot/1.0)' },
      redirect: 'manual',
    });

    if (res.status === 200) {
      return { valid: true, detail: `Daxko ping: 200 OK — session active` };
    }

    if (res.status === 301 || res.status === 302) {
      const loc = res.headers.get('location') || '';
      const isLoginRedirect = ['find_account', '/login'].some(k => loc.includes(k));
      if (isLoginRedirect) {
        return { valid: false, detail: `Daxko ping: ${res.status} → login redirect — session expired` };
      }
      // Non-login redirect (e.g. to MyAccount or similar) — treat as valid.
      return { valid: true, detail: `Daxko ping: ${res.status} non-login redirect — session active` };
    }

    if (res.status >= 400) {
      return { valid: false, detail: `Daxko ping: HTTP ${res.status}` };
    }

    // 3xx other than login redirect — ambiguous but lean toward valid.
    return { valid: true, detail: `Daxko ping: HTTP ${res.status} — treated as valid` };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: null, detail: `Daxko ping: timed out after ${PING_TIMEOUT_MS / 1000}s` };
    }
    return { valid: null, detail: `Daxko ping error: ${err.message}` };
  }
}

// ── FamilyWorks ping ──────────────────────────────────────────────────────────

async function pingFamilyWorks(cookies) {
  try {
    const cookie = cookieHeader(cookies, 'my.familyworks.app');
    const res = await fetchWithTimeout(FW_PING_URL, {
      method:  'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (compatible; YMCA-Bot/1.0)',
        Accept: 'application/json',
      },
      redirect: 'follow',
    });

    if (res.status === 401 || res.status === 403) {
      return { valid: false, detail: `FamilyWorks ping: HTTP ${res.status} — session expired` };
    }

    if (res.status === 200) {
      let body = null;
      try { body = await res.json(); } catch { /* treat as inconclusive */ }

      if (body?.status === 'success') {
        return { valid: true, detail: `FamilyWorks ping: 200 OK — session active` };
      }
      if (body?.status === 'error') {
        const msg = body?.message ?? 'unknown error';
        // Unauthorized-type messages → session expired.
        if (/unauthorized|not logged|unauthenticated/i.test(msg)) {
          return { valid: false, detail: `FamilyWorks ping: auth error (${msg})` };
        }
        // Other error messages (e.g. endpoint not found) → inconclusive.
        return { valid: null, detail: `FamilyWorks ping: API error (${msg})` };
      }

      // 200 but unparseable / unexpected body — inconclusive.
      return { valid: null, detail: `FamilyWorks ping: 200 but unexpected body — inconclusive` };
    }

    // Any other status → inconclusive → fall to Tier 3.
    return { valid: null, detail: `FamilyWorks ping: unexpected HTTP ${res.status}` };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: null, detail: `FamilyWorks ping: timed out after ${PING_TIMEOUT_MS / 1000}s` };
    }
    return { valid: null, detail: `FamilyWorks ping network error: ${err.message}` };
  }
}

// ── Timestamp refresh on success ──────────────────────────────────────────────
//
// Stamps fresh checkedAt values into both session files so the next keepalive
// Tier-1 check will pass (data will be < TRUST_THRESHOLD_MIN old).

function refreshStatusTimestamps() {
  const checkedAt = new Date().toISOString();
  try {
    const existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...existing, checkedAt, source: 'keepalive-tier2' }, null, 2));
  } catch { /* non-fatal */ }
  try {
    const existing = JSON.parse(fs.readFileSync(FW_FILE, 'utf8'));
    fs.writeFileSync(FW_FILE, JSON.stringify({ ...existing, checkedAt, source: 'keepalive-tier2' }, null, 2));
  } catch { /* non-fatal */ }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Tier-2: HTTP ping against Daxko + FamilyWorks using saved browser cookies.
 *
 * Returns:
 *   {
 *     trusted:     boolean,   true = both sessions confirmed valid via HTTP
 *     detail:      string,    human-readable summary
 *     daxkoResult: { valid: boolean|null, detail: string },
 *     fwResult:    { valid: boolean|null, detail: string },
 *   }
 *
 * A `null` valid means the result was inconclusive; Tier-2 does NOT trust in
 * that case and keepalive falls through to the full Playwright check (Tier 3).
 *
 * On success (trusted): refreshes both session file timestamps.
 */
async function pingSessionHttp() {
  const cookies = loadCookies();
  if (!cookies) {
    return {
      trusted: false,
      detail: 'No saved cookies — Tier-2 ping skipped',
      daxkoResult: { valid: null, detail: 'No cookies' },
      fwResult:    { valid: null, detail: 'No cookies' },
    };
  }

  console.log('[session-ping] Running Tier-2 HTTP ping (Daxko + FamilyWorks)...');
  const [daxkoResult, fwResult] = await Promise.all([
    pingDaxko(cookies),
    pingFamilyWorks(cookies),
  ]);

  console.log(`[session-ping] Daxko: ${daxkoResult.detail}`);
  console.log(`[session-ping] FamilyWorks: ${fwResult.detail}`);

  const daxkoOk = daxkoResult.valid === true;
  const fwOk    = fwResult.valid === true;

  if (daxkoOk && fwOk) {
    refreshStatusTimestamps();
    return {
      trusted: true,
      detail:  `Tier-2 ping OK — Daxko session active, FamilyWorks session active`,
      daxkoResult,
      fwResult,
    };
  }

  // Determine the primary reason for missing.
  let reason;
  if (!daxkoOk && daxkoResult.valid !== null) {
    reason = daxkoResult.detail;
  } else if (!fwOk && fwResult.valid !== null) {
    reason = fwResult.detail;
  } else {
    reason = !daxkoOk ? daxkoResult.detail : fwResult.detail;
  }

  return {
    trusted: false,
    detail:  `Tier-2 ping miss — ${reason}`,
    daxkoResult,
    fwResult,
  };
}

module.exports = { saveCookies, loadCookies, pingSessionHttp };
