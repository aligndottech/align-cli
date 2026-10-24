import { LOCAL_SHARE_THRESHOLD } from './value-rollup.js';

/**
 * A graph with fewer decisions than this is "sparse" and setup says what to do next.
 *
 * It reuses LOCAL_SHARE_THRESHOLD (5) instead of inventing a number: that is the size at
 * which the CLI already treats a local graph as worth using and sharing, and the size
 * `align ask` already nudges at. Below it, the graph is too thin to answer much.
 */
export const SPARSE_GRAPH_THRESHOLD = LOCAL_SHARE_THRESHOLD;

export function isSparseGraph(total: number): boolean {
  return total < SPARSE_GRAPH_THRESHOLD;
}

/**
 * The lines setup prints when the graph came out empty or thin. Pure strings, no chalk and
 * no I/O. Only commands that exist are named: `align connect github` (PR descriptions,
 * where the reason usually lives), `align connect docs` (ADRs and CLAUDE.md/AGENTS.md),
 * and `align connect` for the picker (Notion, Linear, Jira and the rest). There is no
 * sample-decision or starter-rules command in this CLI, so none is offered.
 */
export function sparseGraphHint(total: number, opts: { bareReadsLocal?: boolean } = {}): string[] | undefined {
  if (!isSparseGraph(total)) return undefined;
  // A bare `align connect` targets whichever graph bare commands read. When that is a cloud graph
  // (logged in, or ALIGN_ENV exported) the printed commands would fill the wrong one, so name the local one.
  const env = opts.bareReadsLocal === false ? ' --env local' : '';
  const lead =
    total === 0
      ? 'Your graph is empty. Nothing in the history or docs here stated a reason.'
      : `Your graph has ${total} ${total === 1 ? 'decision' : 'decisions'}. That is thin.`;
  return [
    lead,
    'The reason for a change usually lives somewhere else. Add it:',
    ...[
      ['align connect github', 'PR descriptions'],
      ['align connect docs', 'ADRs, CLAUDE.md, AGENTS.md'],
      ['align connect', 'pick another source (Notion, Linear, Jira ...)'],
    ].map(([cmd, what]) => `  ${`${cmd}${env}`.padEnd(`align connect github${env}`.length + 3)}${what}`),
  ];
}
