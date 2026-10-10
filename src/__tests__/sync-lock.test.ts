import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('an unreadable lock file is treated as LIVE until its own modified time is 30 minutes old (it is more likely a peer mid-write than a corpse)', () => {
    const f = lockFile(dir, 'sync-github');
    fs.writeFileSync(f, '{not json');
    const mtime = fs.statSync(f).mtimeMs;
    expect(acquireLock('sync-github', { dir, pid: 5, now: () => mtime + 60_000, alive: alive(5) }).ok).toBe(false);
    expect(acquireLock('sync-github', { dir, pid: 5, now: () => mtime + LOCK_STALE_MS - 1000, alive: alive(5) }).ok).toBe(false);
    expect(acquireLock('sync-github', { dir, pid: 5, now: () => mtime + LOCK_STALE_MS + 1000, alive: alive(5) }).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).pid).toBe(5);
  });

  it('a lock is created whole: no moment where the file exists without its body, and no temp file is left', () => {
    const real = fs.linkSync.bind(fs);
    const seen: string[] = [];
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      seen.push(fs.readFileSync(from, 'utf8'));
      expect(fs.existsSync(to)).toBe(false);
      return real(from, to);
    }) as typeof fs.linkSync);
    try {
      expect(acquireLock('sync-github', { dir, pid: 9, now: () => T0, alive: alive(9) }).ok).toBe(true);
    } finally { spy.mockRestore(); }
    expect(JSON.parse(seen[0]!)).toMatchObject({ pid: 9, at: T0 });
    expect(fs.readdirSync(dir)).toEqual(['sync-github.lock']);
  });

  it('L1: a holder that slept past 30 minutes is taken over, and it can SEE it lost the lock (owned() is false, touch() does not steal it back)', () => {
    let t = T0;
    const a = acquireLock('sync-slack', { dir, pid: 111, now: () => t, alive: alive(111, 222) });
    if (!a.ok) throw new Error('hold');
    expect(a.owned()).toBe(true);
    t += LOCK_STALE_MS + 1;
    const b = acquireLock('sync-slack', { dir, pid: 222, now: () => t, alive: alive(111, 222) });
    expect(b.ok).toBe(true);
    expect(a.owned()).toBe(false);
    a.touch();
    a.release();
    expect(b.ok && b.owned()).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile(dir, 'sync-slack'), 'utf8')).pid).toBe(222);
  });

  it('L2: a second process arriving WHILE a takeover is in progress is told the lock is held, so no interleaving leaves two holders', () => {
    const f = lockFile(dir, 'sync-github');
    fs.writeFileSync(f, JSON.stringify({ pid: 1, started_at: 'x', at: T0 - LOCK_STALE_MS - 5, nonce: 'dead' }));
    const dead = (p: number) => p !== 1;
    const real = fs.rmSync.bind(fs);
    let p1: ReturnType<typeof acquireLock> | undefined;
    let p3: ReturnType<typeof acquireLock> | undefined;
    let first = true;
    // The moment P2 removes the stale lock it judged (it holds the takeover guard), two peers arrive.
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      real(p, o);
      if (first && String(p) === f) {
        first = false;
        p1 = acquireLock('sync-github', { dir, pid: 111, now: () => T0, alive: dead });
        p3 = acquireLock('sync-github', { dir, pid: 333, now: () => T0, alive: dead });
      }
    }) as typeof fs.rmSync);
    let p2: ReturnType<typeof acquireLock>;
    try { p2 = acquireLock('sync-github', { dir, pid: 222, now: () => T0, alive: dead }); } finally { spy.mockRestore(); }
    expect([p1?.ok, p2.ok, p3?.ok].filter(Boolean)).toHaveLength(1);
    expect(fs.readdirSync(dir).filter((n) => n.includes('takeover'))).toEqual([]);
  });

  it('a lock replaced by a LIVE peer between "judged stale" and "guard taken" is left alone', () => {
    const f = lockFile(dir, 'sync-github');
    fs.writeFileSync(f, JSON.stringify({ pid: 1, started_at: 'x', at: T0 - LOCK_STALE_MS - 5, nonce: 'dead' }));
    const real = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathLike | number, d: string | ArrayBufferView, o?: fs.WriteFileOptions) => {
      real(p, d, o);
      if (String(p).endsWith('.takeover')) real(f, JSON.stringify({ pid: 333, started_at: 'y', at: T0, nonce: 'peer' }));
    }) as typeof fs.writeFileSync);
    try {
      const mine = acquireLock('sync-github', { dir, pid: 222, now: () => T0, alive: (p) => p === 333 || p === 222 });
      expect(mine).toMatchObject({ ok: false, holder: { pid: 333 } });
    } finally { spy.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).nonce).toBe('peer');
  });

  it('a takeover guard left by a crashed process (older than 10 s) does not block forever', () => {
    const f = lockFile(dir, 'sync-github');
    fs.writeFileSync(f, JSON.stringify({ pid: 1, started_at: 'x', at: T0 - LOCK_STALE_MS - 5, nonce: 'dead' }));
    const g = `${f}.takeover`;
    fs.writeFileSync(g, '{}');
    const mtime = fs.statSync(g).mtimeMs;
    expect(acquireLock('sync-github', { dir, pid: 7, now: () => mtime + 1000, alive: (p) => p !== 1 }).ok).toBe(false); // fresh guard: somebody is mid-takeover
    expect(acquireLock('sync-github', { dir, pid: 7, now: () => mtime + 60_000, alive: (p) => p !== 1 }).ok).toBe(true);
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
