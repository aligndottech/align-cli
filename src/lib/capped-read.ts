import * as p from '@clack/prompts';
import { SYNC_CEILINGS } from './import-defaults.js';
import { CUT_KINDS_BY_SOURCE } from './sync/run-source.js';
import { CAPTURE_SOURCES } from './capture-sources.js';

/** The connectors whose read is a windowed fetch with a ceiling a person can raise with `align import <source> --limit`. */
const WINDOWED = new Set(['github', 'slack', 'jira', 'linear', 'gitlab', 'confluence', 'notion', 'teams', 'zoom']);

const commas = (n: number): string => n.toLocaleString('en-US');

/**
 * The line that follows "Found N items" when N is the cap and not the total. A read that stops at its ceiling returns exactly
 * the ceiling, so "Found 2000 items" read as the size of the source (a fastify clone showed 2,000 Linear items from a team that has
 * more). Said when the count reached the limit in force, or when the fetcher itself reported it did not reach the end. The command is
 * one that exists: `align connect --source <source> --since 30d` reads a shorter, newer window, and `align sync <source>` is offered
 * only for the sources a sync resumes (CUT_KINDS_BY_SOURCE); for the rest it would re-read the same newest items. (`align import` is retired and `align connect` has no --limit, so neither is offered.) Undefined when nothing was cut.
 */
export function cappedNote(o: { source: string; read: number; limit?: number; complete?: boolean }): string | undefined {
  if (!WINDOWED.has(o.source)) return undefined;
  const ceiling = SYNC_CEILINGS[o.source as keyof typeof SYNC_CEILINGS];
  // A limit the person gave below the connector's ceiling is their cap, not the connector's.
  const theirs = o.limit !== undefined && o.limit < ceiling;
  const cap = theirs ? o.limit! : ceiling;
  const label = (CAPTURE_SOURCES as Record<string, { label: string }>)[o.source]?.label ?? o.source;
  const shorter = `To read a shorter, newer window instead: align connect --source ${o.source} --since 30d`;
  // Only where a sync resumes a cut window (CUT_KINDS_BY_SOURCE) does it read further back; elsewhere it re-reads the same newest items.
  const more = o.source in CUT_KINDS_BY_SOURCE ? `To read further back: align sync ${o.source}. ${shorter}` : shorter;
  const left = o.source in CUT_KINDS_BY_SOURCE ? '' : ' The oldest items were left out.';
  if (o.read >= cap && theirs) return `Read ${commas(o.read)} items and stopped at the limit you gave (${commas(cap)}), so there may be more.${left} ${more}`;
  if (o.read >= cap) return `Read ${commas(o.read)} items, the most ${label} reads in one run (the cap is ${commas(cap)}), so ${label} has more than this.${left} ${more}`;
  // Not a claim that more exist: a permission or time skip also ends a read early.
  if (o.complete === false) return `Read ${commas(o.read)} items, but the read stopped before the end, so some items may not have been read.${left} ${more}`;
  return undefined;
}

/** `cappedNote`, printed as a warning under the "Found N items" line. */
export function sayIfCapped(o: Parameters<typeof cappedNote>[0]): void {
  const note = cappedNote(o);
  if (note !== undefined) p.log.warn(note);
}
