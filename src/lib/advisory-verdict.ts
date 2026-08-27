import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * ALI-570: the store that carries an adjudication verdict from the background adjudicator
 * back to the NEXT advisory hook invocation.
 *
 * The hook is retrieval-only inside its window - adjudication measured ~11s against a ~10s
 * host budget, and in local mode it is also the pipeline's only provider egress. So under
 * `--block-on-critical` the hook spawns a detached adjudicator and exits; the adjudicator
 * writes its verdict here; and the next PreToolUse reads it. A verdict names the exact
 * content it judged (a hash of the proposed text), because a deny must hit a RETRY of the
 * adjudicated change, never an unrelated later edit that happens to touch the same file.
 *
 * Everything here is best-effort and fail-open, like advisory-dedup one file over: a
 * malformed store, a full disk or a lost race must never block an edit or error a hook.
 */

/** A verdict older than this cannot block: the working tree has moved on. */
export const VERDICT_TTL_MS = 15 * 60_000;
/**
 * How long a spawn marker suppresses re-spawning for the same content. Short on purpose:
 * a crashed adjudicator must not wedge the pipeline, only debounce it.
 */
export const PENDING_TTL_MS = 2 * 60_000;

/** The conflict shape buildAdvisoryOutput consumes - mirrored, not imported, to keep this
 *  module free of the command layer (the command imports us, never the reverse). */
export interface VerdictConflict {
  decision_id: string;
  title: string;
  summary?: string;
  url?: string;
  reason: string;
  severity: 'critical' | 'warning';
}

export interface StoredVerdict {
  ts: number;
  filePath: string;
  contentHash: string;
  conflicts: VerdictConflict[];
}

interface Store {
  pending?: { ts: number; contentHash: string };
  verdicts: StoredVerdict[];
}

export function contentHashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function storePath(cwd: string): string {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return path.join(tmpdir(), `align-advisory-verdict-${hash}.json`);
}

function readStore(cwd: string): Store {
  try {
    const parsed = JSON.parse(readFileSync(storePath(cwd), 'utf8')) as Store;
    if (!Array.isArray(parsed.verdicts)) return { verdicts: [] };
    return parsed;
  } catch {
    // Absent or corrupt both mean "no verdicts": fail-open, never fail the hook.
    return { verdicts: [] };
  }
}

/** Atomic: tmp + rename, so a reader never sees a half-written store. */
function writeStore(cwd: string, store: Store): void {
  try {
    const file = storePath(cwd);
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), 'utf8');
    renameSync(tmp, file);
  } catch {
    // Best-effort only.
  }
}

function fresh(ts: number, now: number, ttl: number): boolean {
  return now - ts >= 0 ? now - ts <= ttl : false;
}

/**
 * The verdict that may block a retry: fresh, and judging EXACTLY this content. Content
 * identity rather than file identity, so a deny can only hit the change that was
 * adjudicated - an agent that adjusts its approach hashes differently and proceeds.
 */
export function blockableVerdictFor(
  cwd: string,
  contentHash: string,
  now: number = Date.now(),
): StoredVerdict | null {
  const match = readStore(cwd).verdicts.find(
    v => v.contentHash === contentHash && fresh(v.ts, now, VERDICT_TTL_MS),
  );
  return match ?? null;
}

/** Record a verdict, replacing any earlier one for the same content and pruning stale rows. */
export function recordVerdict(cwd: string, verdict: StoredVerdict, now: number = Date.now()): void {
  const store = readStore(cwd);
  store.verdicts = [
    verdict,
    ...store.verdicts.filter(
      v => v.contentHash !== verdict.contentHash && fresh(v.ts, now, VERDICT_TTL_MS),
    ),
  ];
  // A landed verdict supersedes the pending marker that announced it was coming.
  if (store.pending?.contentHash === verdict.contentHash) delete store.pending;
  writeStore(cwd, store);
}

/** True when a fresh adjudication of this exact content is already in flight or decided. */
export function adjudicationExistsFor(
  cwd: string,
  contentHash: string,
  now: number = Date.now(),
): boolean {
  const store = readStore(cwd);
  if (store.pending && store.pending.contentHash === contentHash && fresh(store.pending.ts, now, PENDING_TTL_MS)) {
    return true;
  }
  return store.verdicts.some(v => v.contentHash === contentHash && fresh(v.ts, now, VERDICT_TTL_MS));
}

export function markAdjudicationPending(cwd: string, contentHash: string, now: number = Date.now()): void {
  const store = readStore(cwd);
  store.pending = { ts: now, contentHash };
  writeStore(cwd, store);
}
