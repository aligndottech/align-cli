import type { MirsadLink } from './fetchers/mirsad.js';
import { mirsadUrl } from './fetchers/mirsad.js';
import { applyJudgement, MarkError } from './curation/mark.js';
import type { Judge } from './curation/judgements-db.js';
import { createLocalDb } from './local-db.js';

export interface MirsadLinkOutcome { confirmed: number; unmatched: number; refused: number; needsTerminal: boolean }

/**
 * MIRSAD's `supersedes` links are owner-recorded, so they land as confirmed: the same two rows
 * `align mark <newer> replaces <older>` writes (curation/mark.ts), through the same function, so
 * its rules apply unchanged. That is a supersede judgement by this person and a supersedes edge
 * at confidence 1 (id `mark:<judgement id>`), which `align mark --undo` can take back.
 *
 * `align mark ... replaces` needs a terminal because declaring a decision replaced is a person's
 * act and an agent's shell must not do it. An import can write the same claim, so it keeps that
 * rule: no terminal, nothing written, `needsTerminal` says so.
 */
export function confirmMirsadLinks(dbPath: string, links: MirsadLink[], ctx: { judge: Judge; terminal: boolean }): MirsadLinkOutcome {
  const out: MirsadLinkOutcome = { confirmed: 0, unmatched: 0, refused: 0, needsTerminal: false };
  if (links.length === 0) return out;
  if (!ctx.terminal) return { ...out, needsTerminal: true };
  const local = createLocalDb(dbPath);
  const resolved: Array<{ newer: string; older: string }> = [];
  try {
    for (const l of links) {
      const newer = local.findKeyedIdByUrl(mirsadUrl(l.newer));
      const older = local.findKeyedIdByUrl(mirsadUrl(l.older));
      if (newer === null || older === null) out.unmatched++;
      else resolved.push({ newer, older });
    }
  } finally {
    local.close();
  }
  return { ...out, ...applyReplacements(dbPath, resolved, ctx.judge) };
}

/**
 * Write each "newer replaces older" pair (graph ids) as a person's mark, through the same function
 * `align mark` uses, so its rules apply. A pair the mark rules refuse (the older one is ratified) is
 * counted, not written. Shared by every importer whose source records replacements itself.
 */
export function applyReplacements(dbPath: string, pairs: Array<{ newer: string; older: string }>, judge: Judge): { confirmed: number; refused: number } {
  const out = { confirmed: 0, refused: 0 };
  for (const r of pairs) {
    try {
      applyJudgement({ dbPath, judge, origin: { via: 'cli' } }, { action: 'replaces', ...r });
      out.confirmed++;
    } catch (e) {
      if (!(e instanceof MarkError && e.code === 'refused')) throw e;
      out.refused++;
    }
  }
  return out;
}
