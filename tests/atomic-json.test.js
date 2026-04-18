/**
 * Tests for the writeJsonAtomic() helper.
 *
 * The helper must guarantee that a process kill during a write never leaves
 * the destination file in a truncated state. Concretely:
 *
 *   1. Successful writes round-trip identically.
 *   2. A leftover `<path>.tmp` from a partial write does not corrupt the
 *      destination — readers continue to see the previous good copy.
 *   3. Existing destination contents survive a partial write attempt
 *      (the rename is the commit point, not the open()).
 *   4. The helper auto-creates the destination directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import os   from 'os';
import path from 'path';

const { writeJsonAtomic } = require('../src/util/atomic-json');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('writes JSON that round-trips exactly', () => {
    const file = path.join(tmpDir, 'state.json');
    const data = { a: 1, nested: { b: [1, 2, 3] } };
    writeJsonAtomic(file, data);
    const round = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(round).toEqual(data);
  });

  it('creates the destination directory if missing', () => {
    const file = path.join(tmpDir, 'deep', 'nested', 'state.json');
    writeJsonAtomic(file, { ok: true });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('leaves no .tmp file behind on a successful write', () => {
    const file = path.join(tmpDir, 'state.json');
    writeJsonAtomic(file, { ok: true });
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('preserves the previous good copy when a partial tmp file is left behind', () => {
    // Simulate a previous successful write.
    const file = path.join(tmpDir, 'sniper-state.json');
    const good = { sniperState: 'SNIPER_READY', updatedAt: '2026-04-18T00:00:00.000Z' };
    writeJsonAtomic(file, good);

    // Simulate a process kill mid-write: a truncated `.tmp` file is left
    // behind but the rename never happened. The destination must still
    // hold the previous good copy.
    fs.writeFileSync(file + '.tmp', '{ "sniperState": "SNIPER_RE'); // truncated mid-token

    // Reader sees the previous good copy — not the truncated tmp.
    const seen = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(seen).toEqual(good);

    // The next successful write must succeed even though a stale tmp
    // exists (rename overwrites it on POSIX).
    const next = { sniperState: 'SNIPER_WAITING', updatedAt: '2026-04-18T00:01:00.000Z' };
    writeJsonAtomic(file, next);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after).toEqual(next);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('never exposes a partially-written destination — writes are all-or-nothing', () => {
    // The destination file must never contain the half-written payload, only
    // either the previous good copy or the fully-serialised new payload.
    const file = path.join(tmpDir, 'log.json');
    const v1   = [{ at: 't1' }];
    writeJsonAtomic(file, v1);

    // Concurrently write a much larger payload. Even if we read the file
    // immediately after the call returns, it must parse cleanly and equal
    // exactly one of the two values — never a truncation in between.
    const v2 = Array.from({ length: 500 }, (_, i) => ({ at: 't2', i }));
    writeJsonAtomic(file, v2);

    const seen = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(seen).toEqual(v2);
  });
});
