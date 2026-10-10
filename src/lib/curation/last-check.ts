/**
 * LM: what `align check` last looked at, so a person can mark a hit right after seeing it without
 * retyping paths. `$XDG_STATE_HOME/align-cli/last-check.json` (private, overwritten each run).
 * Holds decision ids and repo-relative file paths only; the diff itself is never stored. It never
 * leaves the machine. A missing or unreadable file reads as "no last check".
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absoluteXdg } from '../xdg.js';
import { filesFromDiff } from './mark.js';

export interface LastCheck {
  checked_at: string;
  /** The directory the check ran in: a default from another checkout is not this one's. */
  cwd: string;
  files: string[];
  /** Every decision the check retrieved (a hit hidden by a mark is still here), so a default is offered only for a decision it covered. */
  decision_ids: string[];
}

export function lastCheckPath(): string {
  const xdg = absoluteXdg(process.env, 'XDG_STATE_HOME');
  const home = xdg
    ?? (process.platform === 'win32'
      ? (process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'))
      : path.join(os.homedir(), '.local', 'state'));
  return path.join(home, 'align-cli', 'last-check.json');
}

/**
 * Best effort: a check must never fail because its bookkeeping could not be written. Written to a
 * fresh private temp file (`wx`, 0600) and renamed over the target, so a symlink planted at the
 * target is never written through and an existing file's looser mode is not kept. A target that is
 * not a regular file (a link, a directory) is left alone.
 */
export function writeLastCheck(entry: LastCheck, file = lastCheckPath()): void {
  let tmp: string | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return;
    tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    tmp = undefined;
  } catch {
    // Not writable: marking then asks for --files, which is the honest fallback.
  } finally {
    if (tmp) try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

export function readLastCheck(file = lastCheckPath()): LastCheck | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LastCheck>;
    if (!Array.isArray(v.files) || v.files.some((f) => typeof f !== 'string')) return null;
    const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
    return { checked_at: typeof v.checked_at === 'string' ? v.checked_at : '', cwd: typeof v.cwd === 'string' ? v.cwd : '', files: v.files, decision_ids: strings(v.decision_ids) };
  } catch {
    return null;
  }
}

/** The entry for one check: the files it covered (its own list if it gave one, else read from the diff), every decision it retrieved, and where it ran. Never the diff. */
export function lastCheckFor(
  diff: string,
  result: { relevant_decisions?: Array<{ id: string }>; conflicts?: Array<{ decision_id: string }>; checked_files?: string[] },
  now = new Date(),
  cwd = process.cwd(),
): LastCheck {
  const ids = new Set([...(result.relevant_decisions ?? []).map((d) => d.id), ...(result.conflicts ?? []).map((c) => c.decision_id)]);
  return { checked_at: now.toISOString(), cwd, files: result.checked_files ?? filesFromDiff(diff), decision_ids: [...ids] };
}
