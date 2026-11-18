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
import { resolveEnv } from './resolve-env.js';

/** The fields `align context sync` and this fallback both read off a listed decision. */
export interface ListedDecision {
  title: string;
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
      const rows = await client.listDecisions({ limit: o.limit ?? 200, status: 'active' });
      if (rows.length === 0) return null;
      // The rendered header describes a file Align owns. There is no file here, so say where the list came from instead.
      return renderDecisionsFile(rows.map(contextDecisionOf)).replace(FILE_NOTE, GRAPH_NOTE);
    } finally {
      client.close();
    }
  } catch {
    return null;
  }
}
