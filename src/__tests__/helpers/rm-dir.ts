import fs from 'node:fs';

/**
 * Remove a temp directory the way Windows allows: a process that just exited (or a SQLite
 * handle it held) can keep the folder busy for a moment. fs.rmSync's retry is linear backoff
 * (wait grows by retryDelay on each try), so the total wait is retryDelay * N * (N+1) / 2, not
 * retryDelay * N - the previous (10, 100) was already ~5.5s, not the ~1s it reads as. Still not
 * enough under heavy contention while a spawned child (plus whatever process tree an ESM loader
 * adds) is mid-shutdown: a manual Windows CI run hit EBUSY here (ALI-1669) even with that
 * budget. (20, 150) is ~31.5s - a real e2e test's cleanup is exactly where reliability matters
 * more than shaving seconds, and these options are inert on POSIX (the error codes they retry
 * on are a Windows-only failure mode, so this costs nothing there).
 */
export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
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
