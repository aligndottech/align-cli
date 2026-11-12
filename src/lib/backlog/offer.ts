import { TRACKER_LABEL, type TrackerId } from './trackers.js';

/**
 * The one-line offer to turn a decision into tickets. Smallest version that is useful: `align capture <url>`, the one
 * command where a person has just brought in ONE specific decision and is looking at it. It is one line (no prompt, so it
 * costs nothing to ignore), only at a terminal, only for a decision that carries a plan, and only when a tracker is
 * already connected, so the line is never a dead end. Bulk imports, hooks, CI, launched agents and the MCP tools never
 * reach it. It is a decision about what to PRINT, so it is pure: every input is passed in.
 */
export type OfferSkip = 'off' | 'wrapped' | 'ci' | 'hook' | 'not-a-terminal' | 'bulk' | 'no-tracker' | 'not-plan-shaped';

export interface OfferDecision { id: string; title: string; source_url?: string | null; ai?: { actions?: Array<{ text: string }> } }

export interface OfferInput {
  env: Record<string, string | undefined>;
  /** stdin and stdout are real terminals. */
  tty: boolean;
  inCi: boolean;
  inHook: boolean;
  /** The config switch (`align config backlog-offer`); on unless a person turned it off. */
  enabled: boolean;
  /** How many decisions this step brought in. Only one is ever offered. */
  count: number;
  decision: OfferDecision;
  /** Trackers with a saved connection (not ambient tokens: a GITHUB_TOKEN set for other tools is not consent). */
  trackers: readonly TrackerId[];
  /** The tracker this repo's backlog last went to. */
  saved?: TrackerId;
}

const isSet = (v: string | undefined): boolean => v !== undefined && v !== '';

const ADR_TITLE = /^adr[\s_-]?\d+\b/i;
const ADR_FILE = /\/(?:adrs?|decisions?)\/\d{2,4}[-_][^/]*\.(?:md|mdx|markdown)(?:[?#].*)?$/i;

/** Carries a plan: it lists actions, or it is an ADR (by its title or by the numbered file under adr/ or decisions/). */
export function isPlanShaped(d: OfferDecision): boolean {
  if ((d.ai?.actions?.length ?? 0) > 0) return true;
  return ADR_TITLE.test(d.title.trim()) || ADR_FILE.test(d.source_url ?? '');
}

export function backlogOffer(i: OfferInput): { line: string } | { skip: OfferSkip } {
  if (!i.enabled || isSet(i.env['ALIGN_NO_BACKLOG_OFFER'])) return { skip: 'off' };
  if (isSet(i.env['ALIGN_WRAPPED'])) return { skip: 'wrapped' };
  if (i.inCi) return { skip: 'ci' };
  if (i.inHook) return { skip: 'hook' };
  if (!i.tty) return { skip: 'not-a-terminal' };
  if (i.count !== 1) return { skip: 'bulk' };
  if (i.trackers.length === 0) return { skip: 'no-tracker' };
  if (!isPlanShaped(i.decision)) return { skip: 'not-plan-shaped' };
  const known = i.saved && i.trackers.includes(i.saved) ? i.saved : i.trackers.length === 1 ? i.trackers[0] : undefined;
  return { line: `Turn this into tickets${known ? ` in ${TRACKER_LABEL[known]}` : ''}? align backlog ${i.decision.id}` };
}
