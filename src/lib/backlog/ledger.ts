import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * What `align backlog` has already created, per decision + tracker + target. The plan is stored with the issues, so a
 * run that died halfway resumes from the SAME tasks: re-asking the model would shape different ones and duplicate.
 * The file holds titles, bodies and issue keys the person already sent to their own tracker. No credential.
 */
export interface PlannedTask { title: string; body: string; key?: string; url?: string; uncertain?: boolean }
export interface LedgerEntry { tasks: PlannedTask[]; at: string }
type LedgerFile = Record<string, LedgerEntry>;

/** `where` is the workspace when the tracker has one in hand (the Jira site). Case is folded: ENG and ali are one team. */
export const ledgerKey = (decisionId: string, tracker: string, target: string, where = ''): string => `${decisionId}|${tracker}|${where.toLowerCase()}|${target.toLowerCase()}`;

function read(file: string): LedgerFile {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    // An unreadable ledger must stop the run: guessing "empty" would create every issue a second time.
    throw new Error(`The backlog ledger at ${file} is not readable JSON. Fix or remove it, then run again.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The backlog ledger at ${file} is not the expected shape. Fix or remove it, then run again.`);
  }
  return parsed as LedgerFile;
}

export function getEntry(file: string, key: string): LedgerEntry | undefined {
  return read(file)[key];
}

export function putEntry(file: string, key: string, entry: LedgerEntry): void {
  const all = read(file);
  all[key] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Another `align backlog` holds the ledger. Its run will have created the issues, so waiting would only repeat them. */
export class LockedError extends Error {
  constructor() { super('Another align backlog is already running here, so this one stopped before creating anything. When it finishes, run this again: it will show what was created.'); this.name = 'LockedError'; }
}

/** A lock older than this is a crashed run's, whatever its pid says (pids are reused). */
const STALE_MS = 15 * 60_000;

function holderGone(lock: string): boolean {
  let held: { pid?: unknown; at?: unknown };
  try { held = JSON.parse(fs.readFileSync(lock, 'utf8')) as typeof held; } catch { return true; }
  const age = typeof held.at === 'string' ? Date.now() - Date.parse(held.at) : Number.NaN;
  if (!Number.isFinite(age) || age > STALE_MS) return true;
  if (typeof held.pid !== 'number') return true;
  try { process.kill(held.pid, 0); return false; } catch (e) { return (e as { code?: string }).code === 'ESRCH'; }
}

/**
 * Run `fn` holding `<ledger>.lock`, created exclusively so two runs cannot both pass the "already created?" check and
 * both create. A second run does not wait: it throws LockedError. A dead holder's lock is taken over by RENAMING it away,
 * which only one of several racing runs can do, and a run releases the lock only while it still carries its own nonce, so
 * a slow run can never delete the lock of the run that replaced it.
 */
export async function withLock<T>(ledgerFile: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${ledgerFile}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const nonce = randomBytes(8).toString('hex');
  const take = (): boolean => {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce }), { flag: 'wx', mode: 0o600 }); return true; } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return false;
      throw e;
    }
  };
  if (!take()) {
    if (!holderGone(lock)) throw new LockedError();
    const away = `${lock}.stale.${process.pid}.${nonce}`;
    try { fs.renameSync(lock, away); fs.rmSync(away, { force: true }); } catch { throw new LockedError(); }
    if (!take()) throw new LockedError();
  }
  try { return await fn(); } finally {
    try { if ((JSON.parse(fs.readFileSync(lock, 'utf8')) as { nonce?: string }).nonce === nonce) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}
