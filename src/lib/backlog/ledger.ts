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

/** `where` is the workspace when the tracker has one in hand (the Jira site). Case is folded: ALI and ali are one team. */
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
