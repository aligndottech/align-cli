/**
 * LM: what `align check` last looked at, so a person can mark a hit right after seeing it without
 * retyping paths. `$XDG_STATE_HOME/align-cli/last-check.json` (private, overwritten each run).
 * Holds decision ids and repo-relative file paths only; the diff itself is never stored. It never
 * leaves the machine. A missing or unreadable file reads as "no last check".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absoluteXdg } from '../xdg.js';
import { filesFromDiff } from './mark.js';

export interface LastCheck { checked_at: string; files: string[]; decision_ids: string[] }

export function lastCheckPath(): string {
  const xdg = absoluteXdg(process.env, 'XDG_STATE_HOME');
  const home = xdg
    ?? (process.platform === 'win32'
      ? (process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'))
      : path.join(os.homedir(), '.local', 'state'));
  return path.join(home, 'align-cli', 'last-check.json');
}

/** Best effort: a check must never fail because its bookkeeping could not be written. */
export function writeLastCheck(entry: LastCheck, file = lastCheckPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Not writable: marking then asks for --files, which is the honest fallback.
  }
}

export function readLastCheck(file = lastCheckPath()): LastCheck | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LastCheck>;
    if (!Array.isArray(v.files) || v.files.some((f) => typeof f !== 'string')) return null;
    return { checked_at: typeof v.checked_at === 'string' ? v.checked_at : '', files: v.files, decision_ids: Array.isArray(v.decision_ids) ? v.decision_ids.filter((x): x is string => typeof x === 'string') : [] };
  } catch {
    return null;
  }
}

/** The entry for one check: the files it covered (its own list if it gave one, else read from the diff) and the conflict ids. Never the diff. */
export function lastCheckFor(
  diff: string,
  result: { conflicts?: Array<{ decision_id: string }>; checked_files?: string[] },
  now = new Date(),
): LastCheck {
  return {
    checked_at: now.toISOString(),
    files: result.checked_files ?? filesFromDiff(diff),
    decision_ids: (result.conflicts ?? []).map((c) => c.decision_id),
  };
}
