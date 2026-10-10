import { rmDir } from './helpers/rm-dir.js';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimFile, claimInForce, claimProblem, releaseClaim, takeClaim } from '../lib/sync/bg-claim.js';
import { readRegularFile } from '../lib/sync/safe-read.js';

/**
 * L6 review Test List (the launch claim):
 * - One claim per source per interval bucket, created exclusively, never taken over: many racing PROCESSES against a 16-minute-old claim
 *   start exactly one child; with no claim at all, exactly one (positive control); across a bucket boundary, exactly one.
 * - The previous bucket's claim holds while younger than the interval; at exactly the interval it does not. Old files are swept after two intervals.
 * - Objects in the way (a directory at the claim path, an unwritable directory) are a skip with a reason for `align sync --status`, never a block for ever.
 * - A FIFO or a link where a file is expected reads as absent, instantly.
 */
const I = 15 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = 20 * I + 5 * 60_000; // five minutes into bucket 20
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-bgclaim-')); });
afterEach(() => { try { fs.chmodSync(dir, 0o700); } catch { /* gone */ } rmDir(dir); });

function race(n: number, now: number): Promise<number> {
  const barrier = Date.now() + 2500;
  const script = path.join(HERE, 'helpers', 'claim-racer.ts');
  return Promise.all(Array.from({ length: n }, () => new Promise<string>((resolve) => {
    const c = spawn(process.execPath, ['--import', 'tsx', script, dir, 'github', String(now), String(I), String(barrier)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (b: Buffer) => { out += String(b); });
    c.on('close', () => resolve(out));
  }))).then((outs) => outs.filter((o) => o === '1').length);
}

describe('takeClaim', () => {
  it.skipIf(process.platform === 'win32')('20 racing processes against a 16-minute-old claim: exactly one wins', async () => {
    fs.writeFileSync(claimFile(dir, 'github', 19), JSON.stringify({ at: NOW - 16 * 60_000 }));
    expect(await race(20, NOW)).toBe(1);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('positive control: 20 racing processes with no claim at all: exactly one wins', async () => {
    expect(await race(20, NOW)).toBe(1);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('across a bucket boundary: launches a second either side start at most one child', async () => {
    const edge = 21 * I;
    const a = await race(10, edge - 1000);
    rmDir(dir); fs.mkdirSync(dir);
    expect(a).toBe(1);
    expect(takeClaim(dir, 'github', edge - 1000, I).ok).toBe(true);
    expect(takeClaim(dir, 'github', edge + 1000, I)).toEqual({ ok: false, why: 'held' });
  }, 60_000);

  it('the previous bucket holds while younger than the interval and not at exactly the interval (both sides)', () => {
    fs.writeFileSync(claimFile(dir, 'github', 19), JSON.stringify({ at: NOW - I + 1 }));
    expect(takeClaim(dir, 'github', NOW, I)).toEqual({ ok: false, why: 'held' });
    fs.rmSync(claimFile(dir, 'github', 19));
    fs.writeFileSync(claimFile(dir, 'github', 19), JSON.stringify({ at: NOW - I }));
    expect(takeClaim(dir, 'github', NOW, I).ok).toBe(true);
  });

  it('a second launch in the same bucket is held, and a different source is not', () => {
    expect(takeClaim(dir, 'github', NOW, I).ok).toBe(true);
    expect(takeClaim(dir, 'github', NOW + 1000, I)).toEqual({ ok: false, why: 'held' });
    expect(takeClaim(dir, 'jira', NOW, I).ok).toBe(true);
  });

  it('a damaged claim file in this bucket still owns the interval; the next bucket is free again', () => {
    fs.writeFileSync(claimFile(dir, 'github', 20), '{garbage');
    expect(takeClaim(dir, 'github', NOW, I)).toEqual({ ok: false, why: 'held' });
    expect(takeClaim(dir, 'github', NOW + I * 2, I).ok).toBe(true);
  });

  it('release gives the claim back; files older than two intervals are swept, newer kept', () => {
    expect(takeClaim(dir, 'github', NOW, I).ok).toBe(true);
    releaseClaim(dir, 'github', NOW, I);
    expect(claimInForce(dir, 'github', NOW, I)).toBe(false);
    fs.writeFileSync(claimFile(dir, 'github', 10), '{}');
    fs.writeFileSync(claimFile(dir, 'github', 18), '{}');
    expect(takeClaim(dir, 'github', NOW, I).ok).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual([`github.18.bgclaim`, `github.20.bgclaim`]);
  });
});

describe.skipIf(process.platform === 'win32')('objects in the way', () => {
  it('a directory at the claim path is a skip with a reason, not a silent hold: unwritable, and the status line names it', () => {
    fs.mkdirSync(claimFile(dir, 'github', 20));
    expect(takeClaim(dir, 'github', NOW, I)).toEqual({ ok: false, why: 'unwritable' });
    expect(claimProblem(dir, 'github', NOW, I)).toContain('not a file');
    expect(claimProblem(dir, 'jira', NOW, I)).toBeUndefined();
  });
  it('an unwritable state directory is a skip, and the status line says so (not as root)', () => {
    if (process.getuid?.() === 0) return;
    fs.chmodSync(dir, 0o500);
    expect(takeClaim(dir, 'github', NOW, I)).toEqual({ ok: false, why: 'unwritable' });
    expect(claimProblem(dir, 'github', NOW, I)).toContain('cannot write');
  });
  it('a FIFO at a claim path, or at the file read, is absent and returns at once; so is a link', () => {
    const fifo = claimFile(dir, 'github', 20);
    execFileSync('mkfifo', [fifo]);
    const t0 = performance.now();
    expect(readRegularFile(fifo)).toBeUndefined();
    expect(claimInForce(dir, 'github', NOW, I)).toBe(false);
    expect(takeClaim(dir, 'github', NOW, I)).toEqual({ ok: false, why: 'unwritable' });
    expect(performance.now() - t0).toBeLessThan(50);
    const real = path.join(dir, 'real.json'); fs.writeFileSync(real, '{"at":1}');
    const link = path.join(dir, 'link.json'); fs.symlinkSync(real, link);
    expect(readRegularFile(real)).toBe('{"at":1}');
    expect(readRegularFile(link)).toBeUndefined();
    expect(readRegularFile(path.join(dir, 'missing'))).toBeUndefined();
  });
});
