/**
 * L5: the sync lock. One writer per source, across processes, on every OS.
 *
 * A lock is a small file created ATOMICALLY WITH ITS CONTENT: the body is written to a private
 * temp file and hard-linked into place, and link fails if the name exists, so a reader never sees a
 * half-written lock and two processes cannot both create it. (A filesystem without hard links
 * falls back to the exclusive-create flag.) It holds the pid, the start time and a nonce. It is
 * STALE when its pid is gone or it has not been touched for 30 minutes (a pid can be reused, and a
 * run quiet for half an hour has stopped). A lock file that cannot be read is NOT stale until its
 * own modified time is 30 minutes old: a corrupt file is more likely a peer mid-write than a corpse.
 *
 * Takeover is serialised by a guard file (`<lock>.takeover`, exclusive create): one process at a
 * time judges a lock stale, removes it and creates its own, and it re-reads the lock after taking
 * the guard so it removes only the lock it judged. A second process arriving meanwhile is told the
 * lock is held, which is the safe answer.
 *
 * A holder can still lose its lock (a laptop asleep past 30 minutes, then a peer took over). The
 * holder therefore asks `owned()` before every batch it commits and before it records its result,
 * and stops if the answer is no: at worst one batch of idempotent upserts overlaps.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alignStateDir, pidAlive } from '../backfill-state.js';
import { readRegularFile } from './safe-read.js';

export const LOCK_STALE_MS = 30 * 60_000;
/** A takeover guard is held for microseconds; one older than this is a corpse. */
const GUARD_STALE_MS = 10_000;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface LockBody { pid: number; started_at: string; at: number; nonce: string }

export type Lock =
  | { ok: true; /** Is the lock file still mine? False after a takeover or a release. */ owned(): boolean; touch(): void; release(): void }
  /** `holder` is absent when the lock could not be taken for a reason that names no process. */
  | { ok: false; holder?: { pid: number; started_at: string } };

export interface LockOptions {
  dir?: string;
  pid?: number;
  now?: () => number;
  alive?: (pid: number) => boolean;
}

export function lockFile(dir: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`Not a valid lock name: ${JSON.stringify(name.slice(0, 40))}`);
  return path.join(dir, `${name}.lock`);
}

function read(file: string): { raw: string; body: LockBody | undefined } | undefined {
  const raw = readRegularFile(file, 4096);
  if (raw === undefined) return undefined;
  try {
    const b = JSON.parse(raw) as Partial<LockBody>;
    if (Number.isInteger(b.pid) && typeof b.at === 'number' && typeof b.started_at === 'string' && typeof b.nonce === 'string') return { raw, body: b as LockBody };
  } catch { /* not a lock body */ }
  return { raw, body: undefined };
}

function ageOf(file: string, now: number): number {
  try { return now - fs.statSync(file).mtimeMs; } catch { return Number.POSITIVE_INFINITY; }
}

/** Create `file` holding `body` in one atomic step, or report that it exists. */
function createWhole(file: string, body: string, tag: string): boolean {
  const tmp = `${file}.tmp.${tag}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'EEXIST') return false;
    // No hard links here (some network and FAT filesystems): the exclusive-create flag is the next best atomic.
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e2) {
      if ((e2 as { code?: string }).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function acquireLock(name: string, o: LockOptions = {}): Lock {
  const dir = o.dir ?? alignStateDir();
  if (dir === null) return { ok: false };
  const file = lockFile(dir, name);
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now;
  const alive = o.alive ?? pidAlive;
  const mine: LockBody = { pid, started_at: new Date(now()).toISOString(), at: now(), nonce: randomBytes(8).toString('hex') };
  const create = (): boolean => createWhole(file, JSON.stringify(mine), `${pid}.${mine.nonce}`);

  const held = (seen: ReturnType<typeof read>): Lock => (seen?.body ? { ok: false, holder: { pid: seen.body.pid, started_at: seen.body.started_at } } : { ok: false });
  /** Is what we read a lock somebody may still be using? */
  const live = (seen: NonNullable<ReturnType<typeof read>>): boolean =>
    seen.body !== undefined ? alive(seen.body.pid) && now() - seen.body.at <= LOCK_STALE_MS : ageOf(file, now()) <= LOCK_STALE_MS;

  if (!create()) {
    const seen = read(file);
    if (seen === undefined) {
      // Gone between our create and our read: its holder just released it. One more try decides.
      if (!create()) return { ok: false };
    } else if (live(seen)) {
      return held(seen);
    } else {
      const guard = `${file}.takeover`;
      const guardBody = JSON.stringify({ pid, at: now() });
      let guarded = false;
      for (let attempt = 0; attempt < 2 && !guarded; attempt++) {
        try {
          fs.writeFileSync(guard, guardBody, { flag: 'wx', mode: 0o600 });
          guarded = true;
        } catch (e) {
          if ((e as { code?: string }).code !== 'EEXIST') throw e;
          if (ageOf(guard, now()) <= GUARD_STALE_MS) return { ok: false }; // somebody is taking it over right now
          fs.rmSync(guard, { force: true });
        }
      }
      if (!guarded) return { ok: false };
      try {
        const again = read(file);
        // Only the lock we judged stale may be removed. Anything else is a peer's: leave it.
        if (again !== undefined && again.raw !== seen.raw) return held(again);
        if (again !== undefined) fs.rmSync(file, { force: true });
        if (!create()) return { ok: false };
      } finally {
        fs.rmSync(guard, { force: true });
      }
    }
  }

  const ownsIt = (): boolean => read(file)?.body?.nonce === mine.nonce;
  return {
    ok: true,
    owned: ownsIt,
    touch() {
      if (!ownsIt()) return;
      const tmp = `${file}.touch.${pid}.${mine.nonce}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ ...mine, at: now() }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch { fs.rmSync(tmp, { force: true }); /* the next touch will try again */ }
    },
    release() {
      if (!ownsIt()) return;
      try { fs.rmSync(file, { force: true }); } catch { /* a stale lock is taken over after 30 minutes */ }
    },
  };
}

/** Who holds this lock right now (a live pid, touched within 30 minutes), or undefined. Reads only: it never takes the lock. */
export function lockHolder(name: string, o: LockOptions = {}): { pid: number; started_at: string } | undefined {
  const dir = o.dir ?? alignStateDir();
  if (dir === null) return undefined;
  const body = read(lockFile(dir, name))?.body;
  const now = o.now ?? Date.now;
  const alive = o.alive ?? pidAlive;
  return body !== undefined && alive(body.pid) && now() - body.at <= LOCK_STALE_MS ? { pid: body.pid, started_at: body.started_at } : undefined;
}
