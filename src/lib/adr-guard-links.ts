import { DatabaseSync } from 'node:sqlite';
import type { AdrReplacement } from './fetchers/adr-guard.js';
import type { Judge } from './curation/judgements-db.js';
import { applyReplacements } from './mirsad-links.js';

export interface AdrGuardLinkOutcome { confirmed: number; unmatched: number; refused: number; needsTerminal: boolean }

/**
 * Record ADR Guard's replacements in a local graph. ADR Guard names ADRs by repository path; the
 * graph holds them as docs rows keyed by the file's blob URL, written by `align connect docs`.
 *
 * `urlFor(path)` is the URL that path gets on the branch being read now. A row imported on another
 * branch has the same URL with another branch in it, so it is accepted by path when exactly one
 * docs row of this repository ends in that path. Two candidates are a guess, so the pair is counted
 * unmatched. A section of a file (`CLAUDE.md#heading`) never ends in an ADR path, so it is never taken.
 *
 * Like `align mark ... replaces`, this needs a terminal: declaring a decision replaced is a person's act.
 */
export function confirmAdrGuardLinks(
  dbPath: string,
  replacements: AdrReplacement[],
  urlFor: (path: string) => string,
  ctx: { judge: Judge; terminal: boolean },
): AdrGuardLinkOutcome {
  const out: AdrGuardLinkOutcome = { confirmed: 0, unmatched: 0, refused: 0, needsTerminal: false };
  if (replacements.length === 0) return out;
  if (!ctx.terminal) return { ...out, needsTerminal: true };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const resolved: Array<{ newer: string; older: string }> = [];
  try {
    const exact = db.prepare(`SELECT id FROM decisions WHERE platform = 'docs' AND source_url = ?`);
    const docsUrls = db.prepare(`SELECT id, source_url FROM decisions WHERE platform = 'docs'`).all() as Array<{ id: string; source_url: string | null }>;
    const find = (path: string): string | null => {
      const hit = exact.get(urlFor(path)) as { id: string } | undefined;
      if (hit) return hit.id;
      // The same repository on another branch: everything up to the branch must match, and the path must end
      // the URL. Only a hosted URL names its repository; git://blob/<branch>/<path> does not, so it gets no fallback.
      const here = urlFor(path);
      if (!/^https?:\/\//.test(here) || !here.includes('/blob/')) return null;
      const base = here.slice(0, here.indexOf('/blob/') + '/blob/'.length);
      const candidates = docsUrls.filter((r) => r.source_url !== null && r.source_url.startsWith(base) && r.source_url.endsWith(`/${path}`));
      return candidates.length === 1 ? candidates[0]!.id : null;
    };
    for (const r of replacements) {
      const newer = find(r.newer);
      const older = find(r.older);
      if (newer === null || older === null) out.unmatched++;
      else resolved.push({ newer, older });
    }
  } finally {
    db.close();
  }
  return { ...out, ...applyReplacements(dbPath, resolved, ctx.judge) };
}
