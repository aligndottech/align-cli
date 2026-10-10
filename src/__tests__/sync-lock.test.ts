import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, LOCK_STALE_MS, lockFile, lockHolder } from '../lib/sync/lock.js';

/**
 * L5 Test List (lock):
 * - Given a held lock with a live pid, a second acquire reports "held" with the holder (so `align sync` can exit 0 "already syncing").
 * - Given a lock whose pid is dead, or older than 30 minutes, it is taken over. Given a fresh lock with a live pid, it is not.
 * - Release removes only our own lock. Two sources never block each other. A name cannot escape the directory.
 * - Liveness is injected here, never assumed from process.kill (which behaves differently on Windows).
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-lock-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
const T0 = 1_800_000_000_000;

describe('acquireLock', () => {
  it('takes a free lock, and writes the pid and start time as JSON', () => {
    const l = acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111) });
    expect(l.ok).toBe(true);
    const body = JSON.parse(fs.readFileSync(lockFile(dir, 'sync-github'), 'utf8'));
    expect(body).toMatchObject({ pid: 111, at: T0 });
    expect(Date.parse(body.started_at)).toBe(T0);
  });

  it('a held lock with a live pid is NOT taken: the result names the holder', () => {
    const first = acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111, 222) });
    expect(first.ok).toBe(true);
    const second = acquireLock('sync-github', { dir, pid: 222, now: () => T0 + 60_000, alive: alive(111, 222) });
    expect(second).toMatchObject({ ok: false, holder: { pid: 111 } });
    expect(JSON.parse(fs.readFileSync(lockFile(dir, 'sync-github'), 'utf8')).pid).toBe(111);
  });

  it('a lock whose pid is dead is taken over', () => {
    acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111) });
    const second = acquireLock('sync-github', { dir, pid: 222, now: () => T0 + 1_000, alive: alive(222) });
    expect(second.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile(dir, 'sync-github'), 'utf8')).pid).toBe(222);
  });

  it('a lock older than 30 minutes is taken over even if its pid answers (a recycled pid, a hung run)', () => {
    acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111, 222) });
    const justUnder = acquireLock('sync-github', { dir, pid: 222, now: () => T0 + LOCK_STALE_MS - 1, alive: alive(111, 222) });
    expect(justUnder.ok).toBe(false);
    const over = acquireLock('sync-github', { dir, pid: 222, now: () => T0 + LOCK_STALE_MS + 1, alive: alive(111, 222) });
    expect(over.ok).toBe(true);
  });

  it('touch() keeps a long run fresh: its age is counted from the last touch', () => {
    let now = T0;
    const l = acquireLock('sync-github', { dir, pid: 111, now: () => now, alive: alive(111, 222) });
    if (!l.ok) throw new Error('should hold');
    now = T0 + 25 * 60_000;
    l.touch();
    now = T0 + 40 * 60_000;
    expect(acquireLock('sync-github', { dir, pid: 222, now: () => now, alive: alive(111, 222) }).ok).toBe(false);
  });

  it('an unreadable lock file (a half-written one) counts as stale, not as a permanent block', () => {
    fs.writeFileSync(lockFile(dir, 'sync-github'), '{not json');
    expect(acquireLock('sync-github', { dir, pid: 5, now: () => T0, alive: alive(5) }).ok).toBe(true);
  });

  it('release removes our lock; releasing after a takeover leaves the new holder\'s lock alone', () => {
    const a = acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111) });
    if (!a.ok) throw new Error('hold');
    a.release();
    expect(fs.existsSync(lockFile(dir, 'sync-github'))).toBe(false);

    const old = acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111, 222) });
    if (!old.ok) throw new Error('hold');
    const taker = acquireLock('sync-github', { dir, pid: 222, now: () => T0 + LOCK_STALE_MS + 5, alive: alive(222) });
    expect(taker.ok).toBe(true);
    old.release();
    expect(JSON.parse(fs.readFileSync(lockFile(dir, 'sync-github'), 'utf8')).pid).toBe(222);
  });

  it('different sources do not block each other', () => {
    expect(acquireLock('sync-github', { dir, pid: 1, now: () => T0, alive: alive(1, 2) }).ok).toBe(true);
    expect(acquireLock('sync-slack', { dir, pid: 2, now: () => T0, alive: alive(1, 2) }).ok).toBe(true);
  });

  it('a lock name cannot leave the directory', () => {
    expect(() => acquireLock('../evil', { dir, pid: 1, now: () => T0, alive: alive(1) })).toThrow(/lock name/);
    expect(() => acquireLock('a/b', { dir, pid: 1, now: () => T0, alive: alive(1) })).toThrow(/lock name/);
  });

  it('two contenders in one tick: exactly one wins', () => {
    const results = [1, 2].map((pid) => acquireLock('sync-github', { dir, pid, now: () => T0, alive: alive(1, 2) }));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('lockHolder (read only)', () => {
  it('names a live, fresh holder and never takes or removes the lock', () => {
    acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111) });
    expect(lockHolder('sync-github', { dir, now: () => T0 + 1000, alive: alive(111) })).toMatchObject({ pid: 111 });
    expect(fs.existsSync(lockFile(dir, 'sync-github'))).toBe(true);
  });
  it('a dead pid, a stale lock, a missing lock and a corrupt lock are all "nobody"', () => {
    acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: alive(111) });
    expect(lockHolder('sync-github', { dir, now: () => T0, alive: alive() })).toBeUndefined();
    expect(lockHolder('sync-github', { dir, now: () => T0 + LOCK_STALE_MS + 1, alive: alive(111) })).toBeUndefined();
    expect(lockHolder('sync-jira', { dir, now: () => T0, alive: alive(111) })).toBeUndefined();
    fs.writeFileSync(lockFile(dir, 'sync-slack'), '{bad');
    expect(lockHolder('sync-slack', { dir, now: () => T0, alive: alive(111) })).toBeUndefined();
  });
});
