import { trackChildFromEnv } from './backfill-state.js';

// THIRD, right after startup-xdg: when `align_backfill` started this process, record from the first
// moment how it ends. Anything later (a bad --since, a commander parse error, an uncaught error)
// exits through process.exit, which the exit handler turns into a final "failed" status.
trackChildFromEnv();
