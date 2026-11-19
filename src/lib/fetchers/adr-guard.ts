import { readFile } from 'node:fs/promises';

/**
 * Read ADR Guard's relationships export (github.com/rodri-oliveira-dev/adr-guard, from v1.12.0:
 * `adr-guard export relationships`, written to `.adr-guard/relationships.json`). The contract is
 * ADR Guard's own, docs/adr-relationships-export-v1.md: ADR metadata, declared relationships with
 * how each target resolved, and the validation issues ADR Guard found.
 *
 * The export carries no ADR text. The ADRs themselves come in through `align connect docs`, and this
 * reader only says which of them replaced which, by repository-relative path.
 *
 * Its own rules, followed here:
 *  - only `resolution: "resolved"` names a single target; `ambiguous` and `unresolved` never pair;
 *  - a resolved target is not a valid relationship, so `issues` are read first. A pair is held back
 *    when ADR Guard reports an error on either of its ADRs (a supersession cycle, say);
 *  - a newer minor schema version is read, another major is refused.
 */

export class AdrGuardFileError extends Error {}

/** `newer` replaces `older`, both repository-relative paths. */
export interface AdrReplacement { newer: string; older: string }

export interface AdrGuardRead {
  replacements: AdrReplacement[];
  /** Declarations whose target was ambiguous or unresolved. */
  unresolved: number;
  /** Replacements left out because ADR Guard reported an error on one of their two ADRs. */
  heldBack: number;
  /** `depends-on` declarations, which are not replacements and are not recorded. */
  dependsOn: number;
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Portable and inside the repository: `/` separated, not absolute, no `.` or `..` segment. */
function repoPath(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  if (v.startsWith('/') || v.includes('\\') || /^[A-Za-z]:/.test(v)) throw new AdrGuardFileError(`a path is not repository-relative: ${v}`);
  if (v.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new AdrGuardFileError(`a path is not repository-relative: ${v}`);
  return v;
}

export function parseAdrGuardExport(value: unknown): AdrGuardRead {
  if (!isRecord(value) || !Array.isArray(value['relationships'])) {
    throw new AdrGuardFileError('this is not an ADR Guard relationships export (run `adr-guard export relationships`)');
  }
  const version = value['schemaVersion'];
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) throw new AdrGuardFileError('the export has no schemaVersion');
  if (version.split('.')[0] !== '1') throw new AdrGuardFileError(`schema ${version} is not supported; this version of align reads 1.x`);

  const erroring = new Set<string>();
  for (const issue of list(value['issues'])) {
    if (isRecord(issue) && issue['severity'] === 'error') {
      const path = repoPath(issue['path']);
      if (path) erroring.add(path);
    }
  }

  const out: AdrGuardRead = { replacements: [], unresolved: 0, heldBack: 0, dependsOn: 0 };
  const seen = new Set<string>();
  const held = new Set<string>();
  for (const r of list(value['relationships'])) {
    if (!isRecord(r)) continue;
    const type = r['type'];
    if (type === 'depends-on') { out.dependsOn++; continue; }
    if (type !== 'supersedes' && type !== 'superseded-by') continue;
    if (r['resolution'] !== 'resolved') { out.unresolved++; continue; }
    const source = repoPath(r['sourcePath']);
    const target = repoPath(r['targetPath']);
    if (!source || !target || source === target) continue;
    const pair = type === 'supersedes' ? { newer: source, older: target } : { newer: target, older: source };
    const key = `${pair.newer}\n${pair.older}`;
    if (erroring.has(pair.newer) || erroring.has(pair.older)) {
      if (!held.has(key)) { held.add(key); out.heldBack++; }
      continue;
    }
    // Both ADRs may declare the same replacement; it is one pair.
    if (seen.has(key)) continue;
    seen.add(key);
    out.replacements.push(pair);
  }
  return out;
}

export async function readAdrGuardExport(file: string): Promise<AdrGuardRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new AdrGuardFileError(`cannot read ${file}. Run \`adr-guard export relationships\` first, or pass --file.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AdrGuardFileError(`${file} is not valid JSON`);
  }
  return parseAdrGuardExport(value);
}
