/**
 * ALI-831: `align push <id>` - per-item promotion of a ratified local decision to the shared
 * graph, through the existing ingestBatch contract. No bulk flag in v1: Tom's ruling is
 * per-item push after ratify, never bulk. The cloud derives decider_kind from the platform
 * the item carries, so the platform travels verbatim.
 *
 * Test List:
 * 1. the resolved env is the local graph itself: refuse, name --env / login
 * 2. no such local row: exit non-zero
 * 3. an unratified row: refuse, name `align ratify <id>`, ingestBatch never called
 * 4. a ratified agent-session row: ingestBatch called once with the row's platform, source
 *    URL, title, summary as raw_text and decided_at as created_at; then the cloud row is
 *    ratified by the pusher; an audit row records where it went
 * 5. a ratified row with no source URL gets a stable synthesized one, so a re-push upserts
 *    rather than duplicating
 * 6. the cloud ratify failing does not unmake the push: warn, exit 0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn() })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('prod'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));
const envs = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: (name: string) => envs.current[name] })),
}));
const ingestBatch = vi.hoisted(() => vi.fn());
const cloudRatify = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ ingestBatch, ratifyDecision: cloudRatify })),
}));
const getGitIdentity = vi.hoisted(() => vi.fn().mockResolvedValue('tom@align.tech'));
vi.mock('../lib/git.js', () => ({
  getGitIdentity,
  resolveLocalIdentity: async () => (await getGitIdentity()) ?? 'os-fallback-user',
}));

import { createLocalDb } from '../lib/local-db.js';
import { registerPushCommand } from '../commands/push.js';

const out: string[] = [];
const err: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
let exitCode: number | undefined;
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  exitCode = code;
  throw new Error(`process.exit(${code})`);
}) as never);

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali831-push-'));
  dbPath = path.join(dir, 'local.db');
  envs.current = {
    local: { mode: 'local-embedded', localDbPath: dbPath, gatewayUrl: '' },
    prod: { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: 'tn' },
  };
  resolveEnv.mockReturnValue('prod');
  ingestBatch.mockReset().mockResolvedValue({ snapshots: [{ id: 'cloud-1', title: 't', summary: 's' }] });
  cloudRatify.mockReset().mockResolvedValue({ alreadyRatified: false, ratifiedBy: 'u1', ratifiedAt: '2026-09-03T15:00:00.000Z' });
});
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(opts: { ratify?: boolean; sourceUrl?: string | null; platform?: string; decidedAt?: string | null } = {}): string {
  const db = createLocalDb(dbPath);
  const id = db.insertDecision({
    title: 'Agent picked sqlite for the cache',
    summary: 'The session settled on sqlite because it ships with node',
    sourceUrl: opts.sourceUrl === undefined ? 'claude-session://s1/m1' : opts.sourceUrl,
    platform: opts.platform ?? 'agent-session',
    deciderKind: 'agent',
    decidedAt: 'decidedAt' in opts ? opts.decidedAt : '2026-09-02T09:00:00.000Z',
  });
  if (opts.ratify) db.markRatified(id, 'tom@align.tech');
  db.close();
  return id;
}

async function run(args: string[]): Promise<void> {
  out.length = 0; err.length = 0; exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerPushCommand(program);
  try {
    await program.parseAsync(['node', 'align', 'push', ...args]);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

function audit(id: string) {
  const db = createLocalDb(dbPath);
  opened.push(db);
  return db.listAudit(id);
}

describe('align push refuses', () => {
  it('when the resolved env is the local graph, naming how to address the shared one', async () => {
    resolveEnv.mockReturnValue('local');
    const id = seed({ ratify: true });
    await run([id]);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/--env|align login/);
    expect(ingestBatch).not.toHaveBeenCalled();
  });

  it('when the local graph does not hold the id', async () => {
    await run(['no-such-id']);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toContain('no-such-id');
    expect(ingestBatch).not.toHaveBeenCalled();
  });

  it('an unratified row, and says what to run first', async () => {
    const id = seed({ ratify: false });
    await run([id]);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toContain(`align ratify ${id}`);
    expect(ingestBatch).not.toHaveBeenCalled();
  });
});

describe('align push of a ratified row', () => {
  it('sends exactly one item with the platform and provenance the cloud classifies on, then ratifies the cloud row', async () => {
    const id = seed({ ratify: true });
    await run([id]);
    expect(exitCode).toBeUndefined();
    expect(ingestBatch).toHaveBeenCalledTimes(1);
    const [items, opts] = ingestBatch.mock.calls[0]!;
    expect(items).toEqual([{
      source_url: 'claude-session://s1/m1',
      platform: 'agent-session',
      title: 'Agent picked sqlite for the cache',
      raw_text: 'The session settled on sqlite because it ships with node',
      created_at: '2026-09-02T09:00:00.000Z',
    }]);
    // Not deferred: one item, and the cloud row should be enriched before anyone reads it.
    expect(opts?.deferEnrichment).toBeFalsy();
    expect(cloudRatify).toHaveBeenCalledWith('cloud-1');
    expect(audit(id).map((a) => [a.action, a.detail])).toEqual([['pushed', 'prod:cloud-1']]);
    expect(out.join('\n')).toContain('cloud-1');
  });

  // The negative control for the cloud's classification lives cloud-side (deriveDeciderKind);
  // what this half can pin is that a cli row's platform reaches the wire unchanged.
  it('sends a cli row as cli, so the cloud still classifies it human', async () => {
    const id = seed({ ratify: true, platform: 'cli', sourceUrl: 'https://example.com/doc' });
    await run([id]);
    expect(ingestBatch.mock.calls[0]![0][0].platform).toBe('cli');
  });

  it('attributes the audit row to the pusher (git identity), not the ratifier - two different people', async () => {
    getGitIdentity.mockResolvedValue('dan@align.tech');
    const id = seed({ ratify: true }); // ratified as 'tom@align.tech' inside seed()
    await run([id]);
    expect(audit(id).map((a) => a.actor)).toEqual(['dan@align.tech']);
  });

  it('synthesizes a stable source URL for a row that has none, so a re-push upserts', async () => {
    const id = seed({ ratify: true, sourceUrl: null, platform: 'cli', decidedAt: null });
    await run([id]);
    const item = ingestBatch.mock.calls[0]![0][0];
    expect(item.source_url).toBe(`align-local://decision/${id}`);
    expect(item).not.toHaveProperty('created_at');
  });

  it('keeps the push when the cloud ratification fails, and says what to run', async () => {
    cloudRatify.mockRejectedValue(new Error('Gateway returned 403 for /decisions/cloud-1/ratify'));
    const id = seed({ ratify: true });
    await run([id]);
    expect(exitCode).toBeUndefined();
    expect(audit(id).map((a) => a.action)).toEqual(['pushed']);
    expect(out.join('\n')).toMatch(/align ratify cloud-1 --env prod/);
  });
});
