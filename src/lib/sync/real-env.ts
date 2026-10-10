/**
 * L5: the production wiring of `SyncEnv` and `StatusDeps`: the real config store, the real graph,
 * the real lock directory and the real backfill status files. Kept out of the command so the
 * command is argument handling and printing only, and out of run-source.ts so that file stays a
 * function of its injected world.
 */
import { backfillDir, liveBackfills, pidAlive, readStatus, statusPath } from '../backfill-state.js';
import { createConfigStore } from '../config.js';
import { createLocalGatewayClient } from '../local-gateway-client.js';
import { getLocalDbPath } from '../local-mode.js';
import { acquireLock, lockHolder } from './lock.js';
import type { SyncEnv } from './run-source.js';
import { fetchSource, fetchWhole, scopeOf } from './sources.js';
import type { StatusDeps } from './status.js';

/** The local graph this machine syncs into, or undefined when local mode is not set up. Never creates it. */
export function localGraphPath(config = createConfigStore()): string | undefined {
  const env = config.getEnvironment('local');
  return env.mode === 'local-embedded' ? (env.localDbPath ?? getLocalDbPath()) : undefined;
}

export function realSyncEnv(dbPath: string, config = createConfigStore()): SyncEnv {
  const dir = backfillDir();
  return {
    dbPath,
    now: () => new Date(),
    tokens: (source) => config.getConnectorFields('local', source),
    scopeOf,
    fetch: fetchSource,
    fetchWhole,
    client: createLocalGatewayClient(dbPath),
    lock: (name) => acquireLock(name),
    backfillRunning: (source) => dir !== null && liveBackfills(dir).some((s) => s.source === source),
  };
}

export function realStatusDeps(dbPath: string, config = createConfigStore()): StatusDeps {
  return {
    dbPath,
    isConnected: (id) => Boolean(config.getConnectorFields('local', id)?.['token']),
    syncRunning: (id) => lockHolder(`sync-${id}`) !== undefined,
    backfill: (id) => {
      const dir = backfillDir();
      return dir ? readStatus(statusPath(dir, id)) : null;
    },
    backfillAlive: (s) => s.state === 'running' && pidAlive(s.pid),
  };
}
