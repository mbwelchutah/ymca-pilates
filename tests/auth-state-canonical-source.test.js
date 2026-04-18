/**
 * Task #79 — auth-state.json is the canonical source of truth.
 *
 * Guard test: production code under src/ must NOT read session-status.json.
 * The legacy file is still WRITTEN for backward compatibility (settings UI,
 * external diagnostics) but every reader has been migrated to the auth-state
 * accessor (getAuthState / getCanonicalAuthTruth).
 *
 * If you find this test failing because you added a new reader, migrate the
 * read to require('./auth-state').getCanonicalAuthTruth() instead — see
 * src/scheduler/tick.js or src/bot/readiness-state.js for the pattern.
 *
 * Allowlist (files permitted to mention 'session-status.json'):
 *   - Writers that keep the legacy file in sync for backward compatibility.
 *   - The one-time legacy bootstrap in auth-state.js (cold-start migration
 *     for users who upgrade from a pre-auth-state.json install).
 *   - The settings-clear handler in server.js (deletion / reset).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR   = path.resolve(__dirname, '../src');

// Files allowed to reference session-status.json.  Anything outside this list
// that mentions the file (in code, not a comment) is a regression.
const ALLOWLIST = new Set([
  'bot/session-check.js',  // legacy writer + saveStatus export
  'bot/session-ping.js',   // refreshes timestamp on Tier-2 ping success (writer)
  'bot/settings-auth.js',  // writes Daxko half on settings login (writer)
  'bot/auth-state.js',     // one-time legacy bootstrap (_deriveFromLegacy) +
                           //   migration history comment
  'web/server.js',         // /api/settings-clear deletion + comment trail
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'data' || entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Strip line and block comments so the scan only sees real code references,
// not migration history or "DO NOT read…" warnings.  Naive but sufficient for
// our codebase (no comment-shaped substrings appear inside string literals
// in the files under test).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* … */
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // // …  (the (^|[^:]) guard avoids
                                         // eating the // in URLs like https://)
}

describe('Task #79 — session-status.json is no longer read by production code', () => {
  it('every src/ reference to session-status.json is on the writer/bootstrap allowlist', () => {
    const offenders = [];

    for (const file of walk(SRC_DIR)) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (!text.includes('session-status.json')) continue;

      const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
      if (ALLOWLIST.has(rel)) continue;

      offenders.push(rel);
    }

    expect(
      offenders,
      `New reference(s) to session-status.json detected outside the writer allowlist:\n  ${offenders.join('\n  ')}\n` +
      `Migrate the read to require('./auth-state').getCanonicalAuthTruth() — ` +
      `see src/scheduler/tick.js for the pattern.`,
    ).toEqual([]);
  });

  it('no production file outside session-check.js calls loadStatus()', () => {
    // loadStatus is the legacy reader for session-status.json.  It is still
    // exported from session-check.js for the settings UI / proxyquire tests,
    // but no production reader should call it.  This catches indirect reads
    // that the file-name scan above would miss.
    const callers = [];

    for (const file of walk(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
      if (rel === 'bot/session-check.js') continue; // definition site
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      // Match a loadStatus call (function invocation), not the bare word in a
      // comment or import statement.  We look for `loadStatus(` preceded by
      // anything other than alphanumerics / underscore so we don't catch
      // longer identifiers like `loadStatusFoo(`.
      if (/(^|[^A-Za-z0-9_])loadStatus\s*\(/.test(text)) {
        callers.push(rel);
      }
    }

    expect(
      callers,
      `loadStatus() (legacy session-status.json reader) is called from:\n  ${callers.join('\n  ')}\n` +
      `Replace with require('./auth-state').getCanonicalAuthTruth().`,
    ).toEqual([]);
  });
});
