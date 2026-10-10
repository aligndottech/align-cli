/**
 * A question nobody answers must not hold anything. A terminal that exists but has nobody behind it (a pty an agent opened and never
 * typed into) would wait on a confirm forever, and a sync holding its lock while it waits blocks every other sync for 30 minutes. After
 * `ms` the answer is No, the same as a closed stdin.
 */
export const CONFIRM_TIMEOUT_MS = 60_000;

export async function askWithTimeout(ask: () => Promise<boolean>, ms: number = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const no = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
  try {
    return await Promise.race([ask().catch(() => false), no]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
