import chalk from 'chalk';
import { parseSince, SinceError, type SyncWindow } from './since.js';

/** The help line for `--since`, one writer for every command that takes it. */
export const SINCE_HELP = 'How far back to read: 30d, 2w, 6m, 1y or all (default 180 days). A ceiling still applies';

/**
 * L3: the CLI end of the one duration parser. A bad value exits 2 (usage error) naming the
 * accepted forms, before any request is made: a window the user did not mean would be read
 * and reported as complete. `align_backfill` calls parseSince directly and returns the same
 * message as a tool error.
 */
export function sinceFromFlag(raw: string | undefined, now: Date = new Date()): SyncWindow {
  try {
    return parseSince(raw, now);
  } catch (e) {
    if (!(e instanceof SinceError)) throw e;
    console.error(chalk.red(`align connect: ${e.message}`));
    return process.exit(2);
  }
}
