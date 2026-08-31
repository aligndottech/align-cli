import type { EventEmitter } from 'node:events';
import open from 'open';

/**
 * Open a URL and answer whether it plausibly worked.
 *
 * `open()` resolves when the child process SPAWNS. xdg-open's real verdict arrives
 * AFTERWARDS, as a child exit event nobody was watching - so the old
 * `await open(url).catch(() => {})` reported success for a browser that never
 * appeared, which is the 0.28.0 field failure on every token-paste connector.
 *
 * This waits a short grace window for an early non-zero exit or error. A clean exit
 * or a quiet window reads as success; either failure signal reads as failure. It
 * cannot prove a tab became VISIBLE (nothing can, from here), which is why every
 * caller must print the URL regardless - this only decides whether to warn.
 */
export async function tryOpenUrl(
  url: string,
  opener: (u: string) => Promise<{ pid?: number } & EventEmitter> = open as never,
  graceMs = 400,
): Promise<boolean> {
  try {
    const child = await opener(url);
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(true); }, graceMs);
      const onExit = (code: number | null): void => {
        cleanup();
        // Only a clean 0 is success. code === null means terminated by signal, which
        // is not a handoff - and the cost of a wrong answer is asymmetric: a false
        // warning costs a glance at the printed link, a false success recreates the
        // stranded-at-the-prompt state this helper exists to end.
        resolve(code === 0);
      };
      const onError = (): void => { cleanup(); resolve(false); };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };
      child.once('exit', onExit);
      child.once('error', onError);
    });
  } catch {
    return false;
  }
}
