import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writePrivateFile } from './private-files.js';
import { privateTmpDir } from './advisory-verdict.js';

// Folder-scoped fallback window when the host does not identify the session. Short on
// purpose: the pre- and post-edit hooks for one edit fire within seconds, and a longer
// folder-wide window would silence a second concurrent session in the same checkout.
const DEDUP_TTL_MS = 20_000;

// Session-scoped window when the host sends a session_id (dedupScope encodes it with NUL).
// Multi-edit sessions routinely pause 40-600s between edits while the agent reasons or runs
// tests; keeping the mark per session stops re-injecting the same decision on every turn
// without affecting any other session in the same folder.
export const SESSION_DEDUP_TTL_MS = 60 * 60_000;

// Bound marker files in privateTmpDir(): each unique session id creates one file, so
// without a cap long-lived machines accumulate orphaned advisory-*.json files over time.
// When the cap is exceeded we trim back to the low-water mark so the next 64 sessions hit
// the fast path without rescanning on every edit.
export const MAX_MARKER_FILES = 256;
const PRUNE_TARGET_FILES = 192;

const MARKER_PREFIX = 'advisory-';
const MARKER_SUFFIX = '.json';

interface Marker {
  ts: number;
  ids: string[];
}

function ttlFor(scope: string): number {
  return scope.includes('\0') ? SESSION_DEDUP_TTL_MS : DEDUP_TTL_MS;
}

// In the verified private temp folder (advisory-verdict.ts), never loose in the shared temp dir, where a
// predictable name could be planted by another account. Null when that folder is not safe to use.
function markerPath(cwd: string): string | null {
  const dir = privateTmpDir();
  if (dir === null) return null;
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return path.join(dir, `${MARKER_PREFIX}${hash}${MARKER_SUFFIX}`);
}

function readMarkerTs(file: string): number {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<Marker>;
    return typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : 0;
  } catch {
    return 0;
  }
}

// Reap expired markers first, then oldest-first if still over MAX_MARKER_FILES.
// Fast path: one readdirSync and an immediate return whenever the folder is within cap.
function pruneMarkers(dir: string, now: number, keepName: string): void {
  const names = readdirSync(dir).filter((f) => f.startsWith(MARKER_PREFIX) && f.endsWith(MARKER_SUFFIX));
  if (names.length <= MAX_MARKER_FILES) return;
  const cutoff = now - SESSION_DEDUP_TTL_MS;
  const live: Array<{ name: string; ts: number }> = [];
  for (const name of names) {
    if (name === keepName) continue;
    const full = path.join(dir, name);
    const ts = readMarkerTs(full);
    if (ts < cutoff) {
      try { unlinkSync(full); } catch { /* concurrent reap */ }
    } else {
      live.push({ name, ts });
    }
  }
  const excess = live.length + 1 - PRUNE_TARGET_FILES;
  if (excess <= 0) return;
  live.sort((a, b) => a.ts - b.ts);
  for (const victim of live.slice(0, excess)) {
    try { unlinkSync(path.join(dir, victim.name)); } catch { /* concurrent reap */ }
  }
}

function readMarker(cwd: string, now: number): Marker | null {
  try {
    const file = markerPath(cwd);
    if (file === null) return null;
    const m = JSON.parse(readFileSync(file, 'utf8')) as Marker;
    if (typeof m.ts !== 'number' || now - m.ts > ttlFor(cwd)) return null;
    return m;
  } catch {
    return null;
  }
}

// What one dedup window covers: a project dir and, when the host names one, the session in it. Two sessions
// (or a subagent) in the same checkout each get told once. A host that sends no session id keeps the
// folder-wide window it had.
export function dedupScope(cwd: string, sessionId: string | undefined): string {
  return sessionId ? `${cwd}\0${sessionId}` : cwd;
}

// Decision ids surfaced within the dedup window for this scope (see dedupScope).
export function recentlySurfaced(cwd: string, now: number = Date.now()): Set<string> {
  return new Set(readMarker(cwd, now)?.ids ?? []);
}

// Record that these decision ids were just surfaced, merging with any still inside
// the window so repeated runs accumulate rather than overwrite.
export function markSurfaced(cwd: string, ids: string[], now: number = Date.now()): void {
  try {
    const merged = new Set([...(readMarker(cwd, now)?.ids ?? []), ...ids]);
    const file = markerPath(cwd);
    if (file === null) return;
    writePrivateFile(file, JSON.stringify({ ts: now, ids: [...merged] } satisfies Marker));
    pruneMarkers(path.dirname(file), now, path.basename(file));
  } catch {
    // Best-effort only - dedup is a nicety, never fail the hook on it.
  }
}
