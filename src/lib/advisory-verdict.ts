import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * ALI-570: the store that carries an adjudication verdict from the background adjudicator
 * back to the NEXT advisory hook invocation.
 *
 * The hook is retrieval-only inside its window - adjudication measured ~11s against a ~10s
 * host budget, and in local mode it is also the pipeline's only provider egress. So under
 * `--block-on-critical` the hook spawns a detached adjudicator and exits; the adjudicator
 * writes its verdict here; and the next PreToolUse reads it. A verdict names the exact
 * CHANGE it judged (see `changeIdentityHash` in commands/check.ts - tool, target file,
 * replaced text and new text, not the new text alone), because a deny must hit a RETRY of
 * the adjudicated change and nothing else.
 *
 * Everything here is best-effort and fail-open, like advisory-dedup one file over: a
 * malformed store, a full disk or a lost race must never block an edit or error a hook.
 * That obligation is THIS module's, not its callers' - every export below returns a safe
 * value rather than relying on the blanket catch in runAdvisory.
 */

/** A verdict older than this cannot block: the working tree has moved on. */
export const VERDICT_TTL_MS = 15 * 60_000;
/**
 * How long a spawn marker suppresses re-spawning for the same change. Short on purpose:
 * a crashed adjudicator must not wedge the pipeline, only debounce it. An adjudicator that
 * RAN but could not judge (ALI-414 `unknown`) gets this TTL too, not the verdict TTL - see
 * `adjudicated` below.
 */
export const PENDING_TTL_MS = 2 * 60_000;
/** Cap the store: it is re-parsed on every hook invocation, so it must not grow unbounded. */
export const MAX_STORED_VERDICTS = 64;
/**
 * Ceiling on adjudicators in flight for one project. Each is a detached process making
 * provider calls, and an agent editing quickly proposes DIFFERENT content every time, so
 * the content dedup below does not bound this - only a cap does.
 */
export const MAX_CONCURRENT_ADJUDICATIONS = 3;

/** Longest title/reason/url we will carry back out of the store. */
const MAX_TEXT_FIELD = 400;

/**
 * Bumped whenever StoredVerdict's shape changes. It is part of the FILENAME, so an older
 * CLI on the same machine (a global install beside an `npx` in another project) reads its
 * own store instead of choking on a shape it predates.
 */
const STORE_SCHEMA = 2;

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
  /**
   * True only when the adjudicator reached a judgement. An ALI-414 `unknown` (no provider
   * key, degraded brain, classifier error) records `false`: it must not masquerade as
   * "adjudicated clean", and it must not suppress a retry for the full verdict TTL, or a
   * user with no provider gets a flag that is silently inert for 15 minutes at a time.
   */
  adjudicated: boolean;
  conflicts: VerdictConflict[];
}

interface PendingMark {
  ts: number;
  contentHash: string;
}

interface Store {
  pending: PendingMark[];
  verdicts: StoredVerdict[];
}

const EMPTY: Store = { pending: [], verdicts: [] };

export function contentHashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * A 0700 directory of our own, rather than tmpdir() itself.
 *
 * macOS gives each user a private tmpdir, but on Linux `os.tmpdir()` falls back to /tmp
 * (mode 1777) whenever TMPDIR is unset, and on a shared build host that means two things:
 * the payload file holds the user's proposed source, and this store feeds the text the
 * agent is shown as the reason its edit was refused. Neither belongs in a directory other
 * uids can read or pre-plant symlinks in.
 *
 * Returns null when the directory cannot be established safely, and every caller then
 * degrades to "no store" rather than erroring - fail-open, as everywhere else here.
 *
 * The mode bits are POSIX-only; Windows honours just the read-only flag and reports 0o666.
 * That costs nothing, because the threat is a SHARED tmp directory and Windows already gives
 * each user a private %LOCALAPPDATA%\Temp - which is also why the uid falls back to a
 * constant there rather than trying to synthesise one.
 */
function storeDir(): string | null {
  try {
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'win';
    const dir = path.join(tmpdir(), `align-${uid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdirSync is happy with an existing SYMLINK to a directory, which is exactly what a
    // pre-planting attacker leaves. lstat (never stat) is what tells the two apart.
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    return dir;
  } catch {
    return null;
  }
}

/**
 * Scoped by environment as well as directory: a verdict adjudicated against the prod graph
 * must not answer a proposal made after the user switched to `--local`. Same reasoning as
 * the change hash - the key has to be as specific as the thing it identifies.
 */
function storePath(cwd: string, envName: string): string | null {
  const dir = storeDir();
  if (!dir) return null;
  const hash = createHash('sha1').update(`${cwd}\0${envName}`).digest('hex').slice(0, 16);
  return path.join(dir, `verdict-v${STORE_SCHEMA}-${hash}.json`);
}

/** Where the adjudication payload for one change is handed to the detached child. */
export function adjudicationPayloadPath(contentHash: string): string | null {
  const dir = storeDir();
  if (!dir) return null;
  return path.join(dir, `adjudicate-${contentHash.slice(0, 12)}-${randomUUID()}.json`);
}

function clean(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  // Strip control characters and cap: this text is interpolated verbatim into Claude Code's
  // permissionDecisionReason, which the model reads as an authoritative refusal. Whatever
  // wrote the store does not get to choose how much of the agent's context it occupies.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT_FIELD);
}

function toConflict(raw: unknown): VerdictConflict | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const severity = r['severity'] === 'critical' ? 'critical' : 'warning';
  const conflict: VerdictConflict = {
    decision_id: clean(r['decision_id']),
    title: clean(r['title']),
    reason: clean(r['reason']),
    severity,
  };
  if (typeof r['summary'] === 'string') conflict.summary = clean(r['summary']);
  if (typeof r['url'] === 'string') conflict.url = clean(r['url']);
  return conflict;
}

function toVerdict(raw: unknown): StoredVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['ts'] !== 'number' || !Number.isFinite(r['ts'])) return null;
  if (typeof r['contentHash'] !== 'string' || !r['contentHash']) return null;
  if (!Array.isArray(r['conflicts'])) return null;
  const conflicts = r['conflicts'].map(toConflict).filter((c): c is VerdictConflict => c !== null);
  return {
    ts: r['ts'],
    filePath: clean(r['filePath']),
    contentHash: r['contentHash'],
    adjudicated: r['adjudicated'] === true,
    conflicts,
  };
}

function toPending(raw: unknown): PendingMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['ts'] !== 'number' || !Number.isFinite(r['ts'])) return null;
  if (typeof r['contentHash'] !== 'string' || !r['contentHash']) return null;
  return { ts: r['ts'], contentHash: r['contentHash'] };
}

/**
 * Every row is validated and normalised on the way out. A store is a file in a shared
 * directory, so "it parsed as JSON" says nothing about its shape: one row of the wrong
 * shape used to throw straight through the callers' blanket catch, which silenced the
 * hook ENTIRELY - no deny, no context, not even the ALI-414 could-not-check notice - and
 * did so permanently, because the write path threw on the same row before it could
 * overwrite it. Filtering here is what makes the store self-repairing.
 */
function readStore(cwd: string, envName: string): Store {
  try {
    const file = storePath(cwd, envName);
    if (!file) return { ...EMPTY };
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    const p = parsed as Record<string, unknown>;
    return {
      pending: Array.isArray(p['pending'])
        ? p['pending'].map(toPending).filter((m): m is PendingMark => m !== null)
        : [],
      verdicts: Array.isArray(p['verdicts'])
        ? p['verdicts'].map(toVerdict).filter((v): v is StoredVerdict => v !== null)
        : [],
    };
  } catch {
    // Absent, unreadable or corrupt all mean "no verdicts": fail-open, never fail the hook.
    return { ...EMPTY };
  }
}

/**
 * Atomic AND non-following: a unique temp name plus `wx` (O_EXCL) means a pre-planted
 * symlink at the temp path makes the write FAIL rather than land on its target, and
 * `renameSync` then only ever moves a file we just created ourselves.
 */
function writeStore(cwd: string, envName: string, store: Store): void {
  const file = storePath(cwd, envName);
  if (!file) return;
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(store), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
  }
}

function fresh(ts: number, now: number, ttl: number): boolean {
  return now - ts >= 0 ? now - ts <= ttl : false;
}

/** An unjudged row debounces a respawn; it never earns the full verdict lifetime. */
function ttlFor(verdict: StoredVerdict): number {
  return verdict.adjudicated ? VERDICT_TTL_MS : PENDING_TTL_MS;
}

/**
 * The verdict that may block a retry: fresh, actually adjudicated, and judging EXACTLY this
 * change - both the identity hash and the target file. Change identity rather than file
 * identity, so a deny can only hit the proposal that was adjudicated; an agent that adjusts
 * its approach hashes differently and proceeds.
 */
export function blockableVerdictFor(
  cwd: string,
  envName: string,
  changeHash: string,
  filePath: string,
  now: number = Date.now(),
): StoredVerdict | null {
  const match = readStore(cwd, envName).verdicts.find(
    v =>
      v.contentHash === changeHash &&
      v.filePath === filePath &&
      v.adjudicated &&
      fresh(v.ts, now, VERDICT_TTL_MS),
  );
  return match ?? null;
}

/** Record a verdict, replacing any earlier one for the same change and pruning stale rows. */
export function recordVerdict(
  cwd: string,
  envName: string,
  verdict: StoredVerdict,
  now: number = Date.now(),
): void {
  const store = readStore(cwd, envName);
  store.verdicts = [
    verdict,
    ...store.verdicts.filter(v => v.contentHash !== verdict.contentHash && fresh(v.ts, now, ttlFor(v))),
  ].slice(0, MAX_STORED_VERDICTS);
  // A landed verdict supersedes the pending marker that announced it was coming.
  store.pending = store.pending.filter(
    m => m.contentHash !== verdict.contentHash && fresh(m.ts, now, PENDING_TTL_MS),
  );
  writeStore(cwd, envName, store);
}

/** True when a fresh adjudication of this exact change is already in flight or decided. */
export function adjudicationExistsFor(
  cwd: string,
  envName: string,
  contentHash: string,
  now: number = Date.now(),
): boolean {
  const store = readStore(cwd, envName);
  if (store.pending.some(m => m.contentHash === contentHash && fresh(m.ts, now, PENDING_TTL_MS))) {
    return true;
  }
  return store.verdicts.some(v => v.contentHash === contentHash && fresh(v.ts, now, ttlFor(v)));
}

/** How many adjudicators are currently believed to be running for this project. */
export function inFlightAdjudications(cwd: string, envName: string, now: number = Date.now()): number {
  return readStore(cwd, envName).pending.filter(m => fresh(m.ts, now, PENDING_TTL_MS)).length;
}

/**
 * Mark one change as being adjudicated. Per-change, not a single slot: two interleaved
 * edits used to evict each other's marker, so the debounce silently stopped covering the
 * exact case it exists for.
 */
export function markAdjudicationPending(
  cwd: string,
  envName: string,
  contentHash: string,
  now: number = Date.now(),
): void {
  const store = readStore(cwd, envName);
  store.pending = [
    { ts: now, contentHash },
    ...store.pending.filter(m => m.contentHash !== contentHash && fresh(m.ts, now, PENDING_TTL_MS)),
  ].slice(0, MAX_STORED_VERDICTS);
  writeStore(cwd, envName, store);
}
