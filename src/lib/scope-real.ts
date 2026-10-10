/**
 * L4: the production wiring of `ScopeDeps`: the real config store (local environment), the real folder, the real `fetch`.
 * Kept apart from scope.ts so that file stays a function of its injected world. The GitHub fetcher is imported lazily, only when a folder is read.
 */
import { createConfigStore } from './config.js';
import { currentRepoIdentity } from './repo-identity.js';
import type { ScopeDeps, ScopeStore } from './scope.js';
import { describeScopeKey, type ScopedSource, scopeKeyOf } from './scope-values.js';

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
    isDisclosed: (source, scopeKey) => config.isTeamScopeDisclosed(source, scopeKey),
    markDisclosed: (source, scopeKey) => config.markTeamScopeDisclosed(source, scopeKey),
  };
}

/** What the sync status needs to know about the scope in force, from the stored choice. An unchosen source answers undefined (the most recently started row is used). */
export function scopeStatusHooks(config = createConfigStore()): { activeScopeKey(id: string): string | undefined; pendingScope(id: string): string | undefined } {
  const store = configScopeStore(config);
  const key = (source: string, s: { kind: 'yours' } | { kind: 'team'; labels: string[] } | null): string | undefined =>
    s === null ? undefined : s.kind === 'yours' ? 'yours' : scopeKeyOf(source as ScopedSource, s.labels);
  return {
    activeScopeKey: (id) => {
      const s = store.getScope(id);
      return key(id, s?.kind === 'team' && s.pending ? s.pending.previous : s);
    },
    pendingScope: (id) => {
      const s = store.getScope(id);
      return s?.kind === 'team' && s.pending ? describeScopeKey(id, scopeKeyOf(id as ScopedSource, s.labels), 'team') : undefined;
    },
  };
}

export function realScopeDeps(dbPath: string | undefined, o: { config?: ReturnType<typeof createConfigStore> } = {}): ScopeDeps {
  return {
    store: configScopeStore(o.config),
    dbPath,
    now: () => new Date(),
    isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    // ALI-917's own folder detection, so GitHub has one reader of "which repo am I in" (it is imported lazily: a connector-core fetcher).
    cwdRepo: async () => (await import('./fetchers/github.js')).resolveGitHubRepoScope({}),
    cwdGitlabProject: async () => gitlabPlaceOf(await currentRepoIdentity()),
    fetch: (url, init) => fetch(url, init),
  };
}
