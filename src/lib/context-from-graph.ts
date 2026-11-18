/**
 * The session-start hook's fallback when the repo has no `.align/decisions.md`.
 *
 * `align context inject` prints that file at session start, and only `align context sync` writes
 * it, so after a normal setup the hook printed nothing: the agent met the graph only if it chose
 * to call a tool. For a LOCAL graph the same list can be read straight from the SQLite file on
 * this machine. That keeps the two reasons the hook reads a file rather than the gateway: no
 * network call, and fast enough to sit inside a hook. A hosted graph still needs `align context
 * sync`, because reading it is a network call.
 *
 * Fails open on every branch, like every other hook shim: anything it cannot read is null, and
 * null prints nothing. It never creates a graph file that is not already there.
 */
import fs from 'node:fs';
import { createConfigStore } from './config.js';
import { localCitationFor } from './commit-cite.js';
import { navigableSourceUrl } from './decision-links.js';
import { type ContextDecision, renderDecisionsFile } from './decisions-context.js';
import { createLocalGatewayClient } from './local-gateway-client.js';
import { extractReason } from './reason-extract.js';
import { resolveEnv } from './resolve-env.js';

/** The fields `align context sync` and this fallback both read off a listed decision. */
export interface ListedDecision {
  title: string;
  platform?: string;
  summary?: string;
  source_url?: string | null;
  decider_kind?: string | null;
  ratified_by?: string | null;
  ratified_at?: string | null;
}

/** One listed decision as the decisions file renders it. Shared with `align context sync`, so the two cannot drift. */
export function contextDecisionOf(d: ListedDecision): ContextDecision {
  const cite = localCitationFor(d.source_url ?? undefined);
  // A hosted decision can carry a synthetic align://claimed/... identity, not a place anyone can open.
  const sourceUrl = navigableSourceUrl(d.source_url ?? undefined);
  return {
    title: d.title,
    ...(cite ? { cite } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    // What the renderer needs to put an unratified agent claim in its own section.
    ...(d.decider_kind ? { deciderKind: d.decider_kind } : {}),
    ...(d.ratified_by ? { ratifiedBy: d.ratified_by } : {}),
    ...(d.ratified_at ? { ratifiedAt: d.ratified_at } : {}),
  };
}

export interface GraphEnv { mode?: string; localDbPath?: string }

/** The file header's note (decisions-context.ts), and what this list says instead. A test pins that the swap happened. */
const FILE_NOTE = 'Generated from your decision graph. Edits here are overwritten; this file is owned by\n`align`. Re-run the generator to bring it up to date.';
const GRAPH_NOTE = 'Read from your local Align graph when this session started. There is no file to edit;\n`align context sync` writes one you can read.';

function configuredEnv(): GraphEnv | undefined {
  return createConfigStore().getEnvironment(resolveEnv(undefined, { preferLocalEmbedded: true }));
}

/** The rendered decisions for `root`'s repo from the local graph, or null when there is no local graph or nothing in it. */
export async function decisionsFromLocalGraph(root: string, o: { env?: () => GraphEnv | undefined; limit?: number } = {}): Promise<string | null> {
  try {
    const env = (o.env ?? configuredEnv)();
    if (env?.mode !== 'local-embedded' || !env.localDbPath || !fs.existsSync(env.localDbPath)) return null;
    const client = createLocalGatewayClient(env.localDbPath, { cwd: root });
    try {
      // The same query `align context sync` runs: active only, so a superseded decision never reads as current.
      const rows = await client.listDecisions({ limit: LOCAL_SCAN, status: 'active' });
      if (rows.length === 0) return null;
      // The same selection as the file, so the session and the file never disagree.
      const picked = selectForFile(rows, o.limit ?? LOCAL_FILE_CAP);
      if (picked.decisions.length === 0) return null;
      // The rendered header describes a file Align owns. There is no file here, so say where the list came from instead.
      return renderDecisionsFile(picked.decisions, { leftOut: picked.leftOut }).replace(FILE_NOTE, GRAPH_NOTE);
    } finally {
      client.close();
    }
  } catch {
    return null;
  }
}

/** A commit or PR shaped like a fix, a test, a chore or an issue reference: it states a reason, and it is not a decision. */
const FIX_SHAPED = /^(?:fix(?:es|ed)?|bug|hotfix|tests?|ci|style|chore|build|docs?|refactor|perf|revert|bump|deps?)\b|^#\d+|^\w+\([^)]*\):/i;
/** How many active rows a local graph's file is chosen from, and how many it holds by default. */
export const LOCAL_SCAN = 5000;
export const LOCAL_FILE_CAP = 30;

const CODE_PLATFORMS: ReadonlySet<string> = new Set(['git', 'github', 'gitlab']);
const FEAT_PREFIX = /^feat(?:\([^)]*\))?:\s*(?:#\d+\s*)?/i;
/** Words a choice is written in. Measured on objectionary/eo: these find the replacements and rules, not the fixes. */
const DECISION_SHAPED = /\b(?:adopt|switch(?:ed)? to|move to|migrate|replace[sd]?\b.*\bwith|instead of|deprecate|drop support|requires?|must|always|never|no longer|policy|convention|prefer|standardi[sz]e|forbid|disallow)\b|^use\b/i;

/**
 * What a LOCAL graph's decisions file holds: the repo's written rules (docs) first, then commits and pull requests that
 * read as decisions, each with the reason it states, capped at `limit`. A local graph is every commit that states a reason,
 * and in an active repo most of those are fixes (1,317 of 1,817 on objectionary/eo), which is not what an agent should
 * read as "what was decided". A hosted graph is already curated by the model, so this is never applied to it.
 */
export function selectForFile(rows: ListedDecision[], limit: number): { decisions: ContextDecision[]; leftOut: number; selected: ListedDecision[] } {
  const rules = rows.filter((r) => r.platform === 'docs');
  const choices = rows.filter((r) => r.platform !== 'docs').filter((r) => {
    // Chat and ticket importers already choose decision-shaped items; only commits and PRs are every reasoned change.
    if (!CODE_PLATFORMS.has(r.platform ?? '')) return true;
    // A feat: prefix is dropped first, so "feat: fix retry policy" is judged as the fix it is.
    const title = r.title.replace(FEAT_PREFIX, '');
    return !FIX_SHAPED.test(title) && DECISION_SHAPED.test(title);
  });
  const keptRules = rules.slice(0, limit);
  const keptChoices = choices.slice(0, Math.max(0, limit - Math.min(rules.length, limit)));
  const kept = [...keptRules.map((r) => ({ ...contextDecisionOf(r), kind: 'rule' as const })),
    ...keptChoices.map((r) => {
      const reason = extractReason(r.title, r.summary ?? '');
      return { ...contextDecisionOf({ ...r, title: r.title.replace(FEAT_PREFIX, '') }), kind: 'decision' as const, ...(reason ? { reason } : {}) };
    })];
  // The source rows of what is written, so a caller can judge those and not the ones left out.
  return { decisions: kept, leftOut: rows.length - kept.length, selected: [...keptRules, ...keptChoices] };
}
