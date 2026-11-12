import fs from 'node:fs';
import path from 'node:path';
import { type TrackerId, TRACKERS } from './trackers.js';

/**
 * Where this repo's backlog goes, saved after a run that created its issues so the next run asks nothing. One entry per
 * repo, keyed by the repo identity the scope store already uses (the git remote, else the repo root). The file holds a
 * tracker name and a team key, repo or project key: no credential and no decision text. A file that cannot be read means
 * "nothing saved", which costs one question and never a wrong destination: a preference is not a ledger.
 */
export interface SavedTarget { tracker: TrackerId; target: string }
type TargetsFile = Record<string, SavedTarget>;

function read(file: string): TargetsFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: TargetsFile = {};
    for (const [k, v] of Object.entries(parsed)) {
      const t = (v as { tracker?: unknown } | null)?.tracker;
      const target = (v as { target?: unknown } | null)?.target;
      if (TRACKERS.some((x) => x === t) && typeof target === 'string' && target !== '') out[k] = { tracker: t as TrackerId, target };
    }
    return out;
  } catch {
    return {};
  }
}

export function getSavedTarget(file: string, repoKey: string): SavedTarget | undefined {
  return read(file)[repoKey];
}

export function putSavedTarget(file: string, repoKey: string, t: SavedTarget): void {
  const all = read(file);
  all[repoKey] = { tracker: t.tracker, target: t.target };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
