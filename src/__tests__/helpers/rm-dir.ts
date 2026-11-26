import fs from 'node:fs';

/** The errors Node's own fs.rmSync retry treats as "try again": on Windows they go away within moments. */
const RETRY_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
const TRIES = 20;
const DELAY_MS = 150;

/**
 * Remove a temp directory the way Windows allows: a process that just exited (or a SQLite
 * handle it held) can keep the folder busy for a moment.
 *
 * The retry is done here, not by fs.rmSync's maxRetries. Node 22 retries a folder only when its
 * first rmdir fails with ENOTEMPTY, EEXIST or EPERM. A first rmdir that fails with EBUSY, which is what
 * Windows gives for a folder an exiting child still has as its working directory, is thrown at
 * once (lib/internal/fs/rimraf.js, _rmdirSync). So the old maxRetries: 20 never ran for that
 * case, and main failed on it two seconds into a test.
 *
 * The wait grows by DELAY_MS on each try: 19 waits between 20 tries, 28.5 s in all. A real e2e
 * test's cleanup is where reliability matters more than seconds. Where the old maxRetries did
 * apply it waited about as long (31.5 s), so no case waits longer than before. Pinned by
 * rm-dir-helper.test.ts.
 */
export function rmDir(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === TRIES || !RETRY_CODES.has((err as { code?: string }).code ?? '')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * DELAY_MS);
    }
  }
}

/** Is this process still running? EPERM means it exists and is not ours. */
export function pidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; }
}

/** Wait until a child pid is gone. Returns false on timeout (the caller kills it, so nothing outlives the test). */
export async function waitPidGone(pid: number, timeoutMs = 30_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (pidRunning(pid)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}
