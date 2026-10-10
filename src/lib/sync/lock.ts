/**
 * L5: the sync lock. One writer per source, across processes, on every OS.
 *
 * A lock is a small file made with the exclusive-create flag (`wx`), which the filesystem
 * decides atomically, so two processes cannot both create it. Nothing here uses flock or a
 * named pipe, because neither behaves the same on Windows. It holds the pid, the start time and
 * a nonce, and is STALE when its pid is gone or it has not been touched for 30 minutes (a pid
 * can be reused, and a run that has gone quiet for half an hour has stopped).
 *
 * Takeover is rename-then-create, never unlink-then-create: of several processes that all judge
 * one lock stale, exactly one rename succeeds, so one does not delete the lock another has just
 * taken. The lock that was moved is read back and must be the one that was judged stale.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alignStateDir, pidAlive } from '../backfill-state.js';

export const LOCK_STALE_MS = 30 * 60_000;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface LockBody { pid: number; started_at: string; at: number; nonce: string }

export type Lock =
  | { ok: true; touch(): void; release(): void }
  /** `holder` is absent when the lock file could not even be made (an unusable state directory). */
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
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  try {
    const b = JSON.parse(raw) as Partial<LockBody>;
    if (Number.isInteger(b.pid) && typeof b.at === 'number' && typeof b.started_at === 'string' && typeof b.nonce === 'string') return { raw, body: b as LockBody };
  } catch { /* a half-written file */ }
  return { raw, body: undefined };
}

export function acquireLock(name: string, o: LockOptions = {}): Lock {
  const dir = o.dir ?? alignStateDir();
  if (dir === null) return { ok: false };
  const file = lockFile(dir, name);
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now;
  const alive = o.alive ?? pidAlive;
  const mine: LockBody = { pid, started_at: new Date(now()).toISOString(), at: now(), nonce: randomBytes(8).toString('hex') };

  const create = (): boolean => {
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return false;
      throw e;
    }
  };

  if (!create()) {
    const seen = read(file);
    const live = seen?.body !== undefined && alive(seen.body.pid) && now() - seen.body.at <= LOCK_STALE_MS;
    if (seen === undefined) {
      // Gone between our create and our read: its holder just released it. One more try decides.
      if (!create()) return { ok: false };
    } else if (live) {
      return { ok: false, holder: { pid: seen.body!.pid, started_at: seen.body!.started_at } };
    } else {
      const moved = `${file}.stale.${pid}.${mine.nonce}`;
      try { fs.renameSync(file, moved); } catch { return { ok: false }; } // another process took it over first
      const movedBody = read(moved);
      if (movedBody?.raw !== seen.raw) {
        // What we moved is not what we judged stale: someone replaced it in between. Put it back.
        try { if (!fs.existsSync(file)) fs.renameSync(moved, file); else fs.rmSync(moved, { force: true }); } catch { /* best effort */ }
        const nowHeld = read(file)?.body;
        return nowHeld ? { ok: false, holder: { pid: nowHeld.pid, started_at: nowHeld.started_at } } : { ok: false };
      }
      fs.rmSync(moved, { force: true });
      if (!create()) return { ok: false };
    }
  }

  const ownsIt = (): boolean => read(file)?.body?.nonce === mine.nonce;
  return {
    ok: true,
    touch() {
      if (!ownsIt()) return;
      try { fs.writeFileSync(file, JSON.stringify({ ...mine, at: now() }), { mode: 0o600 }); } catch { /* the next touch will try again */ }
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
