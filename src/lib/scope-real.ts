/**
 * L4: the production wiring of `ScopeDeps`: the real config store (local environment), the real folder, the real `fetch`.
 * Kept apart from scope.ts so that file stays a function of its injected world. Imports no fetcher module, so the MCP server
 * can load it without pulling connector-core in.
 */
import { createConfigStore } from './config.js';
import { currentRepoIdentity } from './repo-identity.js';
import type { ScopeDeps, ScopeStore } from './scope.js';

/** `owner/repo` from a folder identity (`github.com/o/r`), or undefined for any other host or a bare path. */
export function githubPlaceOf(identity: string | null): string | undefined {
  return identity?.startsWith('github.com/') ? identity.slice('github.com/'.length) : undefined;
}

/** `group/project` from `gitlab.com/group/project`. Self-managed hosts are not detected: name them with `--project`. */
export function gitlabPlaceOf(identity: string | null): string | undefined {
  return identity?.startsWith('gitlab.com/') ? identity.slice('gitlab.com/'.length) : undefined;
}

export function configScopeStore(config = createConfigStore()): ScopeStore {
  return {
    getScope: (source) => config.getConnectorScope('local', source),
    saveScope: (source, scope) => config.setConnectorScope('local', source, scope),
    clearScope: (source) => config.clearConnectorScope('local', source),
    fields: (source) => config.getConnectorFields('local', source),
    isDisclosed: (source) => config.isTeamScopeDisclosed(source),
    markDisclosed: (source) => config.markTeamScopeDisclosed(source),
  };
}

export function realScopeDeps(dbPath: string | undefined, o: { cwd?: string; config?: ReturnType<typeof createConfigStore> } = {}): ScopeDeps {
  const identity = (): Promise<string | null> => currentRepoIdentity(o.cwd !== undefined ? { cwd: o.cwd } : {});
  return {
    store: configScopeStore(o.config),
    dbPath,
    now: () => new Date(),
    cwdRepo: async () => githubPlaceOf(await identity()),
    cwdGitlabProject: async () => gitlabPlaceOf(await identity()),
    fetch: (url, init) => fetch(url, init),
  };
}
