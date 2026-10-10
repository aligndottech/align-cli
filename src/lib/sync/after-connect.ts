/**
 * L5: a fresh token was saved for a source (a foreground `align connect`/`setup` that read it
 * successfully). The source is no longer waiting on the person, and the launch summary now lists
 * it. Best effort and silent: a connect must never fail because a cache could not be written.
 */
import fs from 'node:fs';
import { clearNeedsReauth } from './sync-state.js';
import { refreshSummary } from './summary.js';

export function afterSourceConnected(dbPath: string | undefined, source: string, isConnected: (id: string) => boolean): void {
  if (dbPath === undefined || !fs.existsSync(dbPath)) return;
  try {
    clearNeedsReauth(dbPath, source);
    refreshSummary(dbPath, isConnected);
  } catch { /* the next sync rebuilds both */ }
}
