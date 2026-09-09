import type { createConfigStore, EnvName } from './config.js';
import { createGatewayClient } from './gateway-client.js';
import { createLocalDb } from './local-db.js';
import { getLocalDbPath } from './local-mode.js';
import { fetchValueRollup, localValueRollup, type ValueRollup, type ValueRollupClient } from './value-rollup.js';

/**
 * The ALI-215 "what your graph did for you" rollup for an environment, from wherever that
 * environment keeps it: the local SQLite graph for local-embedded, the gateway otherwise.
 * Moved out of status.ts (ALI-950) so the second-run card reads the SAME readout `align
 * status` prints, rather than a second copy of the query that can drift from it.
 *
 * `days` is the window the gateway's impact and reuse-rate endpoints are read over; the
 * local graph has no window (its link counts are all-time) and ignores it.
 */
export async function readValueRollup(
  config: ReturnType<typeof createConfigStore>,
  envName: EnvName,
  opts: { days?: number } = {},
): Promise<{ mode: 'cloud' | 'local'; rollup: ValueRollup }> {
  const env = config.getEnvironment(envName);
  if (env.mode === 'local-embedded') {
    // Same readout `align local status` gives: the honest offline subset. Reuse rate and
    // health need the cloud graph, and renderValueReadout's local mode says so.
    const db = createLocalDb(env.localDbPath ?? getLocalDbPath());
    try {
      // ALI-796: a connector counts as connected once local mode holds a saved token for
      // it - the same check `align local forget` uses to tell "removed" from "nothing saved".
      const isConnected = (id: string) => config.getConnectorFields(envName, id) !== null;
      return { mode: 'local', rollup: localValueRollup(db, isConnected) };
    } finally {
      db.close();
    }
  }
  const client = createGatewayClient(env);
  return { mode: 'cloud', rollup: await fetchValueRollup(client as unknown as ValueRollupClient, opts) };
}
