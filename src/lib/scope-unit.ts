/**
 * Which part of a connector a row came from, and which parts a repo has chosen to read.
 *
 * A row records its unit at import (`jira:ALI`, `linear:ENG`, `confluence:DOCS`), read from its own source URL, which
 * is where every one of these connectors puts it. A repo's choice of scope per connector (config.ts, kept per repo)
 * says which units it reads. A row is visible from a repo when its unit is among the repo's chosen ones.
 *
 * Fail direction: visible. No unit on the row (an older row, or a connector with nothing to name), no choice for the
 * connector, or a "yours" choice (which names no unit) all show the row, exactly as before this existed.
 *
 * Pure: no config, no database. The caller hands in how to read a stored scope.
 */
import type { StoredScope } from './scope-values.js';

/** The connectors whose chosen scope names places a row's URL can be matched against. */
export const UNIT_SOURCES = ['jira', 'linear', 'confluence'] as const;

/**
 * `source:UNIT` for an item of a unit connector, else null. Jira: the project key of `/browse/KEY-12`. Linear: the team
 * key of `/issue/ENG-12/...`. Confluence: the space key of `/spaces/KEY/pages/...`. Upper-cased, as the scopes are.
 * A URL that does not name one (an OAuth fallback host, a viewpage.action link) gives null, never a guess.
 */
export function scopeUnitOf(platform: string, sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  let path: string;
  try { path = new URL(sourceUrl).pathname; } catch { return null; }
  let unit: string | undefined;
  switch (platform) {
    case 'jira': unit = /\/browse\/([A-Za-z][A-Za-z0-9_]*)-\d+(?:\/|$)/.exec(path)?.[1]; break;
    case 'linear': unit = /\/issue\/([A-Za-z][A-Za-z0-9]*)-\d+(?:\/|$)/.exec(path)?.[1]; break;
    case 'confluence': unit = /\/spaces\/(~?[A-Za-z0-9_.-]+)\/pages\//.exec(path)?.[1]; break;
    default: return null;
  }
  return unit ? `${platform}:${unit.toUpperCase()}` : null;
}

/** Per source: the units a repo reads. An empty list is "this repo skips the source". Sources absent from it are unrestricted. */
export type ScopeRestrict = Partial<Record<(typeof UNIT_SOURCES)[number], string[]>>;

/** The restriction a repo's chosen scopes put on what it sees. `read` returns the stored choice for a source in that repo. */
export function restrictFrom(read: (source: string) => StoredScope | null): ScopeRestrict {
  const out: ScopeRestrict = {};
  for (const source of UNIT_SOURCES) {
    let s = read(source);
    // A choice an agent made and no person has confirmed is not in force: what stays in force is what came before it.
    if (s?.kind === 'team' && s.pending) {
      const prev = s.pending.previous;
      s = prev === null ? null : prev.kind === 'team' ? { kind: 'team', values: prev.values, labels: prev.labels } : prev;
    }
    if (s?.kind === 'skip') out[source] = [];
    else if (s?.kind === 'team' && s.labels.length > 0) out[source] = s.labels.map((l) => `${source}:${l.toUpperCase()}`);
  }
  return out;
}

/** Is a row with this unit visible under the restriction? The JS twin of the SQL in local-db.ts. */
export function unitVisible(unit: string | null | undefined, restrict: ScopeRestrict | undefined): boolean {
  if (!unit || !restrict) return true;
  const source = unit.slice(0, unit.indexOf(':')) as keyof ScopeRestrict;
  const allowed = restrict[source];
  return allowed === undefined || allowed.includes(unit);
}
