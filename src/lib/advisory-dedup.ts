import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The pre- and post-edit advisory hooks both fire for a single edit. To avoid
// showing the agent the same conflicting decisions twice, we remember which
// decision ids were surfaced recently (per project dir) and filter them out on the
// next run inside this window. Best-effort: dedup never blocks the hook.
const DEDUP_TTL_MS = 20_000;

interface Marker {
  ts: number;
  ids: string[];
}

function markerPath(cwd: string): string {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return path.join(tmpdir(), `align-advisory-${hash}.json`);
}

function readMarker(cwd: string, now: number): Marker | null {
  try {
    const m = JSON.parse(readFileSync(markerPath(cwd), 'utf8')) as Marker;
    if (typeof m.ts !== 'number' || now - m.ts > DEDUP_TTL_MS) return null;
    return m;
  } catch {
    return null;
  }
}

// Decision ids surfaced within the dedup window for this project dir.
export function recentlySurfaced(cwd: string, now: number = Date.now()): Set<string> {
  return new Set(readMarker(cwd, now)?.ids ?? []);
}

// Record that these decision ids were just surfaced, merging with any still inside
// the window so repeated runs accumulate rather than overwrite.
export function markSurfaced(cwd: string, ids: string[], now: number = Date.now()): void {
  try {
    const merged = new Set([...(readMarker(cwd, now)?.ids ?? []), ...ids]);
    const file = markerPath(cwd);
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ ts: now, ids: [...merged] } satisfies Marker), 'utf8');
  } catch {
    // Best-effort only - dedup is a nicety, never fail the hook on it.
  }
}
