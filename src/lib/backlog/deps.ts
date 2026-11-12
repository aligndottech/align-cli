import os from 'node:os';
import path from 'node:path';
import { alignStateDir } from '../backfill-state.js';
import type { createConfigStore, EnvName } from '../config.js';
import { resolveAppUrl } from '../env-resolver.js';
import type { createGatewayClient } from '../gateway-client.js';
import { currentRepoIdentity } from '../repo-identity.js';
import type { BacklogDeps, DecisionInput } from './run.js';
import { shapeWithModel } from './shape.js';
import { getSavedTarget, putSavedTarget } from './targets.js';
import { type TrackerId, TRACKERS } from './trackers.js';

/**
 * The real wiring of `align backlog`, shared by the command and the MCP tool so there is one place that decides where
 * credentials come from, where the ledger lives and what a saved target is keyed by.
 */
type Config = ReturnType<typeof createConfigStore>;
type Client = ReturnType<typeof createGatewayClient>;

const TOKEN_ENV: Partial<Record<TrackerId, string>> = { linear: 'LINEAR_API_KEY', github: 'GITHUB_TOKEN' };

export interface BacklogPaths { ledgerPath: string; targetsPath: string; plansDir: string }

export function backlogPaths(): BacklogPaths {
  const stateDir = alignStateDir() ?? path.join(os.homedir(), '.align-cli-state');
  return { ledgerPath: path.join(stateDir, 'backlog-ledger.json'), targetsPath: path.join(stateDir, 'backlog-targets.json'), plansDir: path.join(stateDir, 'backlog-plans') };
}

/** This repo's identity (its remote, else its root: the key the scope store uses), or one machine-wide key outside git. */
export async function backlogRepoKey(cwd: string = process.cwd()): Promise<string> {
  return (await currentRepoIdentity({ cwd }).catch(() => null)) ?? 'machine';
}

export interface BacklogDepsInput {
  client: Client; config: Config; envNames: EnvName[]; appUrlEnv: Parameters<typeof resolveAppUrl>[0]; repoKey: string;
  interactive: boolean; choose?: BacklogDeps['choose']; out: (l: string) => void; err: (l: string) => void;
  paths?: BacklogPaths; fetch?: typeof fetch; processEnv?: Record<string, string | undefined>;
}

export function createBacklogDeps(i: BacklogDepsInput): BacklogDeps {
  const paths = i.paths ?? backlogPaths();
  const penv = i.processEnv ?? process.env;
  const [envName] = i.envNames;
  const toInput = (d: { id: string; title: string; summary: string; source_url?: string | null; ai?: { actions?: Array<{ text: string }> } }): DecisionInput =>
    ({ id: d.id, title: d.title, summary: d.summary, sourceUrl: d.source_url ?? null, actions: (d.ai?.actions ?? []).map((a) => a.text) });
  return {
    getDecision: async (id) => toInput(await i.client.getDecision(id)),
    search: async (q) => (await i.client.searchDecisions(q, 8)).results.map((r) => toInput(r as Parameters<typeof toInput>[0])),
    shape: shapeWithModel,
    credentials: (t) => {
      const fromEnv = TOKEN_ENV[t] ? penv[TOKEN_ENV[t]!] : undefined;
      // Connector tokens are saved under the env they were connected in; local mode is where token paste lives.
      let saved: Record<string, string> | null = null;
      for (const n of i.envNames) { saved = i.config.getConnectorFields(n, t); if (saved) break; }
      if (fromEnv) return { ...(saved ?? {}), token: fromEnv };
      return saved;
    },
    fetch: i.fetch ?? fetch,
    ledgerPath: paths.ledgerPath,
    interactive: i.interactive,
    choose: i.choose ?? (async () => null),
    decisionUrl: (id) => (envName === 'local' ? null : `${resolveAppUrl(i.appUrlEnv)}/decisions/${id}`),
    savedTarget: () => getSavedTarget(paths.targetsPath, i.repoKey),
    saveTarget: (t) => putSavedTarget(paths.targetsPath, i.repoKey, t),
    out: i.out,
    err: i.err,
  };
}

/** The trackers with a SAVED connection (`align connect`), in any env this run reads. Ambient tokens are not counted: see offer.ts. */
export function connectedTrackers(config: Pick<Config, 'getConnectorFields'>, envNames: EnvName[]): TrackerId[] {
  return TRACKERS.filter((t) => envNames.some((n) => config.getConnectorFields(n, t) !== null));
}
