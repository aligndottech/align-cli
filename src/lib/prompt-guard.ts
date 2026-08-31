import * as p from '@clack/prompts';

/**
 * Run one interactive prompt so a crash inside the prompt library cannot end the
 * whole command.
 *
 * WHY THIS EXISTS
 * ---------------
 * The shipped binaries are built with `bun build --compile`, so they run on Bun,
 * not Node - and that split produced two generations of field failure that every
 * local Node reproduction passed: clack 0.x getters throwing on an uninitialised
 * value ("undefined is not an object", the Bun phrasing; Node says "Cannot read
 * properties of undefined"), and doubled keystroke echo with phantom-submitted
 * prompts. clack 1.x fixed both upstream and this repo runs it now, verified
 * empirically by driving compiled binaries under a pty.
 *
 * This guard stays as defence in depth for whatever the NEXT library defect is:
 * one prompt failing must cost that prompt and not the run - an uncaught throw
 * here reaches index.ts's handleFatal, which calls process.exit(1) and discards
 * every connector already configured.
 *
 * Deliberately NOT a general try/catch around business logic. It wraps exactly the
 * third-party boundary that is known to be defective.
 */
export async function guardedPrompt<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  // Everything the prompt adds to stdin is removed if it crashes. A prompt that
  // throws never runs its close(), so its keypress handler stays bound - and the
  // NEXT prompt's first keystroke fires the dead prompt's handlers against its
  // half-built state. Observed on 0.27.0: the guard caught GitHub's crash, and the
  // stale listener then killed the run from inside GitLab's prompt anyway. A DIFF,
  // not a wipe: listeners that predate the prompt are not ours to remove.
  const preexisting = new Set(process.stdin.listeners('keypress'));

  // And a bridge for the throw the await can never see: clack's crashes happen in
  // stream-write and keypress CALLBACKS, so they surface as uncaughtException, not
  // as a rejection of the awaited promise. While this one prompt is active, that
  // class of failure becomes "skip the prompt" instead of process.exit(1).
  let onUncaught: ((err: Error) => void) | undefined;
  const bridged = new Promise<null>((resolve) => {
    onUncaught = (err: Error) => {
      process.removeListener('uncaughtException', onUncaught!);
      p.log.warn(`${label}: the prompt failed (${err.message}). Skipping it.`);
      resolve(null);
    };
    process.on('uncaughtException', onUncaught);
  });

  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .catch((err: Error) => {
          p.log.warn(`${label}: the prompt failed (${err.message}). Skipping it.`);
          return null;
        }),
      bridged,
    ]);
  } finally {
    if (onUncaught) process.removeListener('uncaughtException', onUncaught);
    for (const l of process.stdin.listeners('keypress')) {
      if (!preexisting.has(l)) process.stdin.removeListener('keypress', l as () => void);
    }
    // Best-effort: a crashed prompt can strand the terminal in raw mode.
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  }
}
