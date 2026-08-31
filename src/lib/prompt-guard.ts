import * as p from '@clack/prompts';

/**
 * Run one interactive prompt so a crash inside the prompt library cannot end the
 * whole command.
 *
 * WHY THIS EXISTS
 * ---------------
 * The shipped binaries are built with `bun build --compile`, so they run on Bun,
 * not Node. @clack/core's base Prompt leaves `this.value` as `undefined` until the
 * readline layer sets it, and Bun's readline does not initialise it the way Node's
 * does. Every clack getter that reads `this.value` therefore throws on Bun and not
 * on Node - `masked` for a password, `valueWithCursor` for text, and so on.
 *
 * That is why it reached two users while every local reproduction passed: the
 * reproductions ran on Node. The error wording is the tell, and it is worth knowing
 * for next time - Bun says "undefined is not an object (evaluating '...')" where
 * Node says "Cannot read properties of undefined". Both reports carried the Bun
 * phrasing.
 *
 * Fixed upstream in @clack/core 1.x, which is a major version this repo has not
 * taken yet. Until it does, one prompt failing must cost that prompt and not the
 * run: an uncaught throw here reaches index.ts's handleFatal, which calls
 * process.exit(1) and discards every connector already configured.
 *
 * Deliberately NOT a general try/catch around business logic. It wraps exactly the
 * third-party boundary that is known to be defective.
 */
export async function guardedPrompt<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    p.log.warn(`${label}: the prompt failed (${(err as Error).message}). Skipping it.`);
    return null;
  }
}
