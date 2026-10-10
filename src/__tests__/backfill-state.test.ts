import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  admit, backfillChildCommand, reserveSlot, backfillDir, type BackfillStatus, liveBackfills, MAX_PER_SOURCE, MAX_TOTAL,
  pidAlive, readStatus, startBackfillChild, statusPath, trackChildFromEnv, writeStatus,
} from '../lib/backfill-state.js';

/**
 * L3 review 6: at most one running backfill child per source and three in all; a pid file left by a
 * child that died does not block; the files are where `align_sync` (L5) will look. Real files in a
 * scratch XDG_STATE_HOME, real process ids, no vendor.
 */
let state: string;
const KEYS = ['XDG_STATE_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-bf-'));
  process.env['XDG_STATE_HOME'] = state;
  // A fallback to the home directory must land in scratch, never in the real one.
  process.env['HOME'] = state; process.env['USERPROFILE'] = state; process.env['LOCALAPPDATA'] = state;
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(state, { recursive: true, force: true });
});

const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
};
const running = (source: string, pid: number): BackfillStatus => ({ source, pid, started_at: '2026-10-10T12:00:00.000Z', state: 'running' });

describe('where the files live', () => {
  it('is align-cli/backfill under XDG_STATE_HOME, created private', () => {
    const dir = backfillDir()!;
    expect(dir).toBe(path.join(state, 'align-cli', 'backfill'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });

  it('ignores a relative XDG_STATE_HOME (the spec says invalid; an agent-loaded .env can set one)', () => {
    process.env['XDG_STATE_HOME'] = './evil';
    const dir = backfillDir();
    expect(dir === null || !dir.includes('evil')).toBe(true);
  });
});

describe('a status file', () => {
  it('round-trips, and a missing or corrupt file reads as nothing', () => {
    const dir = backfillDir()!;
    const file = statusPath(dir, 'github');
    expect(readStatus(file)).toBeNull();
    writeStatus(file, running('github', process.pid));
    expect(readStatus(file)).toEqual(running('github', process.pid));
    fs.writeFileSync(file, '{not json');
    expect(readStatus(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ source: 'github', pid: 'x' }));
    expect(readStatus(file)).toBeNull();
  });

  it('one file per source', () => {
    const dir = backfillDir()!;
    expect(statusPath(dir, 'github')).not.toBe(statusPath(dir, 'jira'));
    expect(path.dirname(statusPath(dir, 'github'))).toBe(dir);
  });
});

describe('liveBackfills', () => {
  it('lists running children whose process is alive, and not a pid file left by a dead one', () => {
    const dir = backfillDir()!;
    writeStatus(statusPath(dir, 'github'), running('github', process.pid));
    writeStatus(statusPath(dir, 'jira'), running('jira', deadPid()));
    expect(pidAlive(process.pid)).toBe(true);
    expect(liveBackfills(dir).map((s) => s.source)).toEqual(['github']);
  });

  it('does not list a finished one even if its pid is alive (pids get reused)', () => {
    const dir = backfillDir()!;
    writeStatus(statusPath(dir, 'github'), { ...running('github', process.pid), state: 'done', exit_code: 0 });
    expect(liveBackfills(dir)).toEqual([]);
  });

  it('a dead pid is dead', () => {
    expect(pidAlive(deadPid())).toBe(false);
  });
});

describe('admit: the cap', () => {
  const live = (...sources: string[]) => sources.map((s) => running(s, 1));

  it('constants are 1 per source and 3 in all', () => {
    expect([MAX_PER_SOURCE, MAX_TOTAL]).toEqual([1, 3]);
  });

  it('admits when nothing runs, and when other sources run below the total', () => {
    expect(admit([], 'github')).toEqual({ ok: true });
    expect(admit(live('jira', 'slack'), 'github')).toEqual({ ok: true });
  });

  it('refuses a second child for a source that is running, naming the source cap', () => {
    expect(admit(live('github'), 'github')).toMatchObject({ ok: false, reason: 'source' });
  });

  it('refuses a fourth child in all, even for a new source', () => {
    expect(admit(live('jira', 'slack', 'linear'), 'github')).toMatchObject({ ok: false, reason: 'total' });
  });

  it('five calls in a row start at most three', () => {
    const started: string[] = [];
    for (const s of ['github', 'github', 'jira', 'slack', 'linear']) {
      if (admit(started.map((x) => running(x, 1)), s).ok) started.push(s);
    }
    expect(started).toEqual(['github', 'jira', 'slack']);
  });
});

describe('the child command', () => {
  it('npm install: node, this CLI entry, then the arguments', () => {
    expect(backfillChildCommand(['connect', '--env', 'local'], { dist: 'npm', execPath: '/usr/bin/node', argv1: '/pkg/dist/index.js' }))
      .toEqual({ command: '/usr/bin/node', args: ['/pkg/dist/index.js', 'connect', '--env', 'local'] });
  });

  it('binary build (bun --compile): argv[1] is a bunfs path, so the arguments follow the executable directly', () => {
    expect(backfillChildCommand(['connect', '--env', 'local'], { dist: 'binary', execPath: '/usr/local/bin/align', argv1: '/$bunfs/root/align' }))
      .toEqual({ command: '/usr/local/bin/align', args: ['connect', '--env', 'local'] });
  });

  it('falls back to the bare name when an npm run has no argv[1]', () => {
    expect(backfillChildCommand(['x'], { dist: 'npm', execPath: 'node', argv1: undefined }).args).toEqual(['align', 'x']);
  });
});

describe('the child records how it ended', () => {
  it('no env var: nothing is tracked', () => {
    expect(trackChildFromEnv({})).toBeNull();
  });

  it('refuses a status path outside the backfill directory (the env var is not a way to overwrite a file)', () => {
    const outside = path.join(state, 'elsewhere.json');
    expect(trackChildFromEnv({ ALIGN_BACKFILL_STATUS: outside })).toBeNull();
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('inside the directory it writes running with its own pid', () => {
    const file = statusPath(backfillDir()!, 'github');
    const t = trackChildFromEnv({ ALIGN_BACKFILL_STATUS: file });
    expect(t).not.toBeNull();
    expect(readStatus(file)).toMatchObject({ source: 'github', pid: process.pid, state: 'running' });
  });
});

describe('startBackfillChild: "started" only when the OS confirmed the child', () => {
  it('a command that does not exist is not started, within the confirmation window, and leaves no status file', async () => {
    const file = statusPath(backfillDir()!, 'github');
    const t0 = Date.now();
    const r = await startBackfillChild('github', ['x'], file, { command: path.join(state, 'no-such-executable'), args: [] });
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(readStatus(file)).toBeNull();
  });

  it('a real child is started: its pid is returned and recorded as running, and it is alive', async () => {
    const file = statusPath(backfillDir()!, 'github');
    const r = await startBackfillChild('github', ['x'], file, { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 1500)'] });
    expect(r.ok).toBe(true);
    expect(readStatus(file)).toMatchObject({ source: 'github', pid: r.pid, state: 'running' });
    expect(pidAlive(r.pid!)).toBe(true);
    process.kill(r.pid!);
  });

  it('hands the child the status path through the environment, not argv', async () => {
    const file = statusPath(backfillDir()!, 'jira');
    const out = path.join(state, 'env.txt');
    const r = await startBackfillChild('jira', ['x'], file, {
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, String(process.env.ALIGN_BACKFILL_STATUS))`],
    });
    expect(r.ok).toBe(true);
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
    expect(fs.readFileSync(out, 'utf8')).toBe(file);
  });
});

describe('a running status that cannot be true any more does not block (review D)', () => {
  const alive = () => true; // the worst case: the pid exists (it was reused by something else)

  it('a "running" file older than 24 hours is stale, even though its pid answers', () => {
    const dir = backfillDir()!;
    writeStatus(statusPath(dir, 'github'), { source: 'github', pid: 1, state: 'running', started_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    expect(liveBackfills(dir, alive)).toEqual([]);
  });

  it('a fresh one is live (the same file, an hour old)', () => {
    const dir = backfillDir()!;
    writeStatus(statusPath(dir, 'github'), { source: 'github', pid: 1, state: 'running', started_at: new Date(Date.now() - 3_600_000).toISOString() });
    expect(liveBackfills(dir, alive).map((s) => s.source)).toEqual(['github']);
  });

  it('and a stale file does not stop reserveSlot', () => {
    const dir = backfillDir()!;
    writeStatus(statusPath(dir, 'github'), { source: 'github', pid: 1, state: 'running', started_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const r = reserveSlot(dir, 'github', alive);
    expect(r.ok).toBe(true);
    if (r.ok) r.release();
  });
});

describe('the state directory is only trusted when nothing on the way was planted (review E)', () => {
  it.skipIf(process.platform === 'win32')('a symlinked align-cli directory is refused', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(state, 'align-cli'));
    expect(backfillDir()).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]); // and nothing was written through the link
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('a symlinked backfill directory is refused', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-elsewhere-'));
    fs.mkdirSync(path.join(state, 'align-cli'));
    fs.symlinkSync(elsewhere, path.join(state, 'align-cli', 'backfill'));
    expect(backfillDir()).toBeNull();
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('an existing directory of ours that is group/world accessible is tightened to 0700', () => {
    const dir = path.join(state, 'align-cli', 'backfill');
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
    fs.chmodSync(dir, 0o777);
    expect(backfillDir()).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('reserveSlot: the slot is taken in the same tick it is checked (review A)', () => {
  it('two reservations made back to back for one source: only the first wins, with no await between them', () => {
    const dir = backfillDir()!;
    const a = reserveSlot(dir, 'github');
    const b = reserveSlot(dir, 'github');
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: 'source' });
    if (a.ok) a.release();
  });

  it('four reservations for four sources: three win', () => {
    const dir = backfillDir()!;
    const rs = ['github', 'jira', 'slack', 'linear'].map((s) => reserveSlot(dir, s));
    expect(rs.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(rs[3]).toMatchObject({ reason: 'total' });
    for (const r of rs) if (r.ok) r.release();
  });

  it('releasing frees the slot', () => {
    const dir = backfillDir()!;
    const a = reserveSlot(dir, 'github');
    if (a.ok) a.release();
    const b = reserveSlot(dir, 'github');
    expect(b.ok).toBe(true);
    if (b.ok) b.release();
  });

  it('a second SERVER PROCESS cannot pass either: the placeholder file is created exclusively', () => {
    const dir = backfillDir()!;
    // Another process holds the slot: a live pid (this test runner's parent) and a fresh placeholder.
    fs.writeFileSync(path.join(dir, 'github.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }), { flag: 'wx' });
    expect(reserveSlot(dir, 'github')).toMatchObject({ ok: false, reason: 'source' });
  });

  it('a placeholder left by a dead process, or an old one, does not block', () => {
    const dir = backfillDir()!;
    fs.writeFileSync(path.join(dir, 'github.lock'), JSON.stringify({ pid: deadPid(), at: Date.now() }));
    const a = reserveSlot(dir, 'github');
    expect(a.ok).toBe(true);
    if (a.ok) a.release();
    fs.writeFileSync(path.join(dir, 'jira.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000 }));
    const b = reserveSlot(dir, 'jira');
    expect(b.ok).toBe(true);
    if (b.ok) b.release();
  });

  it('release removes the placeholder', () => {
    const dir = backfillDir()!;
    const a = reserveSlot(dir, 'github');
    expect(fs.existsSync(path.join(dir, 'github.lock'))).toBe(true);
    if (a.ok) a.release();
    expect(fs.existsSync(path.join(dir, 'github.lock'))).toBe(false);
  });
});
