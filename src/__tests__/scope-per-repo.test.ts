import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';
import { resolveScope } from '../lib/scope.js';
import { type ConnectScopeCtx, decideConnectScope } from '../lib/scope-connect.js';
import { makeDeps } from './helpers/scope-deps.js';
import { currentRepoIdentity, currentRepoIdentitySync } from '../lib/repo-identity.js';
import { configScopeStore, scopeRepoKey, scopeStatusHooks, SYNC_REPO_ENV } from '../lib/scope-real.js';
import { startSyncChild } from '../lib/sync/spawn-background.js';

vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      private defaults: Record<string, unknown>;
      constructor(opts: { defaults?: Record<string, unknown> }) { this.defaults = opts.defaults ?? {}; store = JSON.parse(JSON.stringify(this.defaults)); }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = JSON.parse(JSON.stringify(this.defaults)); }
    },
  };
});

/**
 * Item 4 Test List (a scope is remembered per repo):
 * - A choice made in repo A is not in force in repo B (two repos, both ways).
 * - A per-machine scope saved before this existed still applies in a repo with no choice of its own.
 * - A repo's own choice beats the per-machine one, and saving never rewrites the per-machine one.
 * - Outside a git repo (no identity) the choice is per machine, as before.
 * - Forgetting the connector removes every repo's choice with it.
 * - The identity is the one the local graph stamps (currentRepoIdentity), read synchronously.
 * - A background child, which runs from the home directory, is told the repo it was started for and resolves the same scope.
 */
const A = 'github.com/acme/api';
const B = 'github.com/acme/web';
const TEAM = { kind: 'team' as const, values: ['t1'], labels: ['ENG'] };

describe('scope is stored per repo', () => {
  // One config object per test: the mocked store is reset by each construction.
  let cfg: ReturnType<typeof createConfigStore>;
  beforeEach(() => { cfg = createConfigStore(); cfg.forgetAllConnectors('local'); });

  it('a choice made in one repo is not in force in another (both directions)', () => {
    configScopeStore(cfg, () => A).saveScope('linear', TEAM);
    expect(configScopeStore(cfg, () => B).getScope('linear')).toBeNull();
    configScopeStore(cfg, () => B).saveScope('jira', { kind: 'yours' });
    expect(configScopeStore(cfg, () => A).getScope('jira')).toBeNull();
    expect(configScopeStore(cfg, () => A).getScope('linear')).toEqual(TEAM);
  });

  it('an old per-machine YOURS is the fallback for a repo with no choice, and a repo choice beats it', () => {
    cfg.setConnectorScope('local', 'linear', { kind: 'yours' });
    expect(configScopeStore(cfg, () => A).getScope('linear')).toEqual({ kind: 'yours' });
    expect(configScopeStore(cfg, () => B).getScope('linear')).toEqual({ kind: 'yours' });
    configScopeStore(cfg, () => A).saveScope('linear', TEAM);
    expect(configScopeStore(cfg, () => A).getScope('linear')).toEqual(TEAM);
    expect(configScopeStore(cfg, () => B).getScope('linear')).toEqual({ kind: 'yours' });
    expect(cfg.getConnectorScope('local', 'linear')).toEqual({ kind: 'yours' });
  });

  it('an old per-machine team or skip is NEVER applied in a repo with no choice of its own (it is how one clone read another\'s team)', () => {
    cfg.setConnectorScope('local', 'linear', TEAM);
    cfg.setConnectorScope('local', 'jira', { kind: 'skip' });
    cfg.setConnectorScope('local', 'confluence', { ...TEAM, pending: { previous: null } });
    for (const source of ['linear', 'jira', 'confluence']) expect(configScopeStore(cfg, () => B).getScope(source)).toBeNull();
    // With no repo identity at all the per-machine choice is all there is, as before.
    expect(configScopeStore(cfg, () => null).getScope('linear')).toEqual(TEAM);
  });

  it('a per-machine pending team whose previous choice was yours is not a yours fallback (only the top-level kind counts)', () => {
    cfg.setConnectorScope('local', 'linear', { ...TEAM, pending: { previous: { kind: 'yours' } } });
    expect(configScopeStore(cfg, () => B).getScope('linear')).toBeNull();
    // Positive control: the same shape with a top-level yours does fall back.
    cfg.setConnectorScope('local', 'jira', { kind: 'yours' });
    expect(configScopeStore(cfg, () => B).getScope('jira')).toEqual({ kind: 'yours' });
  });

  it('skip is never stored without a repo identity (it would switch the source off everywhere)', () => {
    expect(() => configScopeStore(cfg, () => null).saveScope('linear', { kind: 'skip' })).toThrow(/repo/);
    expect(cfg.getConnectorScope('local', 'linear')).toBeNull();
  });

  it('with no repo identity the choice is per machine, as before', () => {
    configScopeStore(cfg, () => null).saveScope('linear', TEAM);
    expect(cfg.getConnectorScope('local', 'linear')).toEqual(TEAM);
    // ...and a repo does not inherit it (only a per-machine yours is a fallback).
    expect(configScopeStore(cfg, () => B).getScope('linear')).toBeNull();
  });

  it('clearing in a repo clears that repo only; forgetting the connector clears every repo', () => {
    configScopeStore(cfg, () => A).saveScope('linear', TEAM);
    configScopeStore(cfg, () => B).saveScope('linear', TEAM);
    configScopeStore(cfg, () => A).clearScope('linear');
    expect(configScopeStore(cfg, () => A).getScope('linear')).toBeNull();
    expect(configScopeStore(cfg, () => B).getScope('linear')).toEqual(TEAM);
    cfg.forgetConnector('local', 'linear');
    expect(configScopeStore(cfg, () => B).getScope('linear')).toBeNull();
  });

  it('a repo path is not read as a connector field', () => {
    configScopeStore(cfg, () => A).saveScope('linear', TEAM);
    expect(cfg.getConnectorFields('local', 'linear')).toBeNull();
  });
});

describe('the repo identity a scope is keyed by', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scope-repo-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }); };

  it('the sync reader agrees with the async one the local graph uses, for a remote and for a remoteless repo', async () => {
    git('init', '-q');
    expect(currentRepoIdentitySync({ cwd: dir })).toBe(await currentRepoIdentity({ cwd: dir }));
    expect(currentRepoIdentitySync({ cwd: dir })).toBe(fs.realpathSync(dir));
    git('remote', 'add', 'origin', 'git@github.com:Acme/API.git');
    expect(currentRepoIdentitySync({ cwd: dir })).toBe('github.com/acme/api');
    expect(await currentRepoIdentity({ cwd: dir })).toBe('github.com/acme/api');
  });

  it('is null outside a git repo', () => {
    expect(currentRepoIdentitySync({ cwd: dir })).toBeNull();
  });

  it('the env a background child is given beats the folder, which is the home directory there', () => {
    vi.stubEnv(SYNC_REPO_ENV, A);
    expect(scopeRepoKey()).toBe(A);
    vi.stubEnv(SYNC_REPO_ENV, '');
    expect(scopeRepoKey()).not.toBe(A);
  });

  it('startSyncChild hands the child the repo it was started for, and nothing when there is none', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const start = (async (_c: string, _a: string[], _x: unknown, _cmd: unknown, _who: unknown, env: Record<string, string>) => { seen.push(env); return { ok: true }; }) as never;
    await startSyncChild(['linear'], { start, repo: A });
    expect(seen[0]?.[SYNC_REPO_ENV]).toBe(A);
    await startSyncChild(['linear'], { start, repo: null });
    expect(seen[1]).not.toHaveProperty(SYNC_REPO_ENV);
  });
});

describe('the bug report: a team chosen once per machine, then a fresh clone of another project', () => {
  const FASTIFY = 'github.com/fastify/fastify';
  it('reads yours there (not ALI) and the picker starts on skip', async () => {
    const cfg = createConfigStore();
    cfg.forgetAllConnectors('local');
    cfg.setConnectorScope('local', 'linear', { kind: 'team', values: ['id-ALI'], labels: ['ALI'] });
    const store = configScopeStore(cfg, () => FASTIFY);
    const deps = makeDeps(undefined, { store: store as never, table: [[/api\.linear\.app/, { body: { data: { teams: { nodes: [{ id: 'id-ALI', key: 'ALI', name: 'Align' }] } } } }]] });
    const r = await resolveScope('linear', deps, { foreground: false });
    expect(r.scope).toBe('yours');
    expect(r.scopeKey).not.toContain('ALI');
    const asked: string[][] = [];
    const ctx: ConnectScopeCtx = {
      deps, interactive: true, quiet: false, flags: {}, citedKeys: () => [], say: () => {}, repoNames: () => ['fastify'],
      prompts: { multiselect: async (_m, _o, initial) => { asked.push(initial); return initial; }, confirm: async () => false },
    };
    const d = await decideConnectScope('linear', { token: 'x' }, ctx);
    expect(asked[0]).toEqual([':skip']);
    expect(d.skipped).toBe(true);
  });
});

describe('a source skipped in this repo (status and agents)', () => {
  it('Confluence skipped is not reported as "needs spaces", while Confluence with nothing chosen still is', () => {
    const cfg = createConfigStore();
    cfg.forgetAllConnectors('local');
    vi.stubEnv(SYNC_REPO_ENV, A);
    try {
      expect(scopeStatusHooks(cfg).blockedScope('confluence')).toMatch(/none are chosen/);
      configScopeStore(cfg, () => A).saveScope('confluence', { kind: 'skip' });
      expect(scopeStatusHooks(cfg).blockedScope('confluence')).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
});
