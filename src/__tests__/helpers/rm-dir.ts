import fs from 'node:fs';

/** Remove a temp directory the way Windows allows: a process that just exited (or a SQLite handle it held) can keep the folder busy for a moment. */
export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
