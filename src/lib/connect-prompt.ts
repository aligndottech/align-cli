/**
 * Gap-driven pull (ALI-796): once `decision_refs` (ALI-792) knows what a decision's
 * text points at, the graph can name its own gaps - a ref whose platform has no
 * connected source. Surfaced as pull, never gate: one line, a real number, the exact
 * command that fills it in.
 *
 * Local-only for now: `decision_refs` lives in the local SQLite graph
 * (local-db.ts). The hosted gateway does not store refs yet, so a cloud rollup
 * carries no gaps - see value-rollup.ts's `mode` split, which already draws this
 * line for similarDecisions.
 */

import type { DecisionRef } from './decision-refs.js';

export interface UnresolvedGap {
  /** The ref's platform bucket, exactly as decision_refs stores it - 'tracker' and
   *  'code' cover more than one connector by construction (decision-refs.ts). */
  platform: DecisionRef['platform'];
  /** Distinct decisions carrying at least one unresolved ref of this platform - the
   *  number the pull copy states ("12 decisions cite..."), not the total ref count.
   *  One decision citing the same Jira key five times must not read as five gaps. */
  decisions: number;
  /** Connector ids that would resolve at least one ref in this bucket. Length 2 for
   *  'tracker' (jira or linear) and 'code' (github or gitlab) - a bare KEY-123 or #N
   *  cannot say which tool it came from. */
  connectors: string[];
}

/** Which connector(s) could fill in a ref of each platform. */
const CANDIDATE_CONNECTORS: Partial<Record<DecisionRef['platform'], string[]>> = {
  github: ['github'],
  jira: ['jira'],
  confluence: ['confluence'],
  linear: ['linear'],
  slack: ['slack'],
  tracker: ['jira', 'linear'],
  code: ['github', 'gitlab'],
};

const PLATFORM_LABEL: Record<string, string> = {
  jira: 'Jira',
  confluence: 'Confluence',
  linear: 'Linear',
  slack: 'Slack',
  github: 'GitHub',
  tracker: 'ticket-tracker',
  code: 'issue-tracker',
};

function connectCommands(connectors: string[]): string {
  return connectors.map((c) => `align import ${c}`).join(' or ');
}

/** "a" or "an", by the label's first letter - "a Jira ref" but "an issue-tracker ref". */
function articleFor(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a';
}

/**
 * The gaps a graph can name for itself: unresolved-ref counts per platform, for
 * platforms with no connected source. Pure - the caller supplies both the refs
 * (each carrying which decision cited it) and how to check a connector, so this
 * has no I/O and needs no fixture beyond plain objects.
 */
export function unresolvedGaps(
  refs: Array<{ decisionId: string; platform: string }>,
  isConnected: (connectorId: string) => boolean,
): UnresolvedGap[] {
  const decisionsByPlatform = new Map<string, Set<string>>();
  for (const r of refs) {
    let set = decisionsByPlatform.get(r.platform);
    if (!set) {
      set = new Set();
      decisionsByPlatform.set(r.platform, set);
    }
    set.add(r.decisionId);
  }

  const gaps: UnresolvedGap[] = [];
  for (const [platform, decisionIds] of decisionsByPlatform) {
    const connectors = CANDIDATE_CONNECTORS[platform as DecisionRef['platform']];
    if (!connectors || connectors.some(isConnected)) continue;
    gaps.push({ platform: platform as DecisionRef['platform'], decisions: decisionIds.size, connectors });
  }
  return gaps.sort((a, b) => b.decisions - a.decisions);
}

/**
 * The end-of-setup pull line - ONE gap, the biggest, never a wall of platforms.
 * "12 of your decisions reference Jira keys I can't read - align import jira when
 * you want them filled in." Null when the graph has no gap to name.
 */
export function setupSummaryLine(gaps: UnresolvedGap[]): string | null {
  if (!gaps.length) return null;
  const top = gaps[0];
  const label = PLATFORM_LABEL[top.platform] ?? top.platform;
  const plural = top.decisions === 1 ? '' : 's';
  const verb = top.decisions === 1 ? 'references' : 'reference';
  const them = top.decisions === 1 ? 'it' : 'them';
  return `${top.decisions} decision${plural} ${verb} ${label} keys I can't read - `
    + `${connectCommands(top.connectors)} when you want ${them} filled in.`;
}

/** `align status`'s per-platform readout line. */
export function statusGapLine(gap: UnresolvedGap): string {
  const label = PLATFORM_LABEL[gap.platform] ?? gap.platform;
  const plural = gap.decisions === 1 ? '' : 's';
  const verb = gap.decisions === 1 ? 'cites' : 'cite';
  return `  ${gap.decisions} decision${plural} ${verb} ${label} I can't read - ${connectCommands(gap.connectors)}`;
}

/**
 * The trailing line under one `align ask` result - only when THIS decision's own
 * refs carry a gap, not the graph-wide count. Reports the first unresolved ref
 * found; a decision citing several missing platforms still gets one line, matching
 * the "one line" restraint the setup summary uses.
 */
export function askTrailingLine(
  refs: Array<{ platform: string }>,
  isConnected: (connectorId: string) => boolean,
): string | null {
  for (const r of refs) {
    const connectors = CANDIDATE_CONNECTORS[r.platform as DecisionRef['platform']];
    if (connectors && !connectors.some(isConnected)) {
      const label = PLATFORM_LABEL[r.platform] ?? r.platform;
      return `cites ${articleFor(label)} ${label} ref I can't read - ${connectCommands(connectors)}`;
    }
  }
  return null;
}
