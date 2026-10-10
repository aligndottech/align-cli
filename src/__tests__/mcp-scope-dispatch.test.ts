import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

/**
 * L4: align_scope as the agent sees it - on the tool list, behind the real dispatcher, refused on a frozen server, and inside the
 * instructions budget. The config store and the graph are doubles or temp files; nothing here reaches a vendor.
 */
const store = vi.hoisted(() => ({
  fields: {} as Record<string, Record<string, string> | null>,
  scopes: {} as Record<string, unknown>,
}));
vi.mock('../lib/config.js', async (orig) => ({
  ...(await orig<object>()),
  createConfigStore: vi.fn(() => ({
    getConnectorFields: vi.fn((_e: string, s: string) => store.fields[s] ?? null),
    getConnectorScope: vi.fn((_e: string, s: string) => store.scopes[s] ?? null),
    setConnectorScope: vi.fn((_e: string, s: string, v: unknown) => { store.scopes[s] = v; }),
    clearConnectorScope: vi.fn((_e: string, s: string) => { delete store.scopes[s]; }),
    isTeamScopeDisclosed: vi.fn(() => false),
    markTeamScopeDisclosed: vi.fn(),
    clearTeamScopeDisclosed: vi.fn(),
  })),
}));

import { dispatchTool, instructionsFor, TOOL_SCHEMAS, toolSchemasFor } from '../commands/mcp.js';
import { createLocalDb } from '../lib/local-db.js';

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let env: EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: null } as EnvironmentConfig;
const client = {} as Parameters<typeof dispatchTool>[2];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l4-dispatch-'));
  const dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
  env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath };
  store.fields = { jira: { token: 't', email: 'e@x.com', domain: 'acme.atlassian.net' }, zoom: { token: 't' } };
  store.scopes = { jira: { kind: 'team', values: ['ALI'], labels: ['ALI'] } };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('align_scope on the published surface', () => {
  it('is listed once, as a write, in both modes, with a closed schema', () => {
    for (const e of [env, cloudEnv]) {
      const matches = toolSchemasFor(e).filter((t) => t.name === 'align_scope');
      expect(matches).toHaveLength(1);
      expect(matches[0]!.annotations?.readOnlyHint).toBe(false);
    }
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'align_scope') as unknown as { inputSchema: { additionalProperties: boolean; required: string[] } };
    expect(schema.inputSchema.additionalProperties).toBe(false);
    expect(schema.inputSchema.required).toEqual(['action']);
  });

  it('leaves the server instructions inside the 2,048-byte budget (the guidance is in the tool description)', () => {
    expect(Buffer.byteLength(instructionsFor(env), 'utf8')).toBeLessThanOrEqual(2048);
    expect(TOOL_SCHEMAS.find((t) => t.name === 'align_scope')!.description).toContain('re-reads');
  });
});

describe('through the real dispatcher', () => {
  it('view reaches the scope code and returns the connected sources', async () => {
    const r = await dispatchTool('align_scope', { action: 'view' }, client, env) as { sources: Array<{ source: string; scope_key: string }>; text: string };
    expect(r.sources.map((s) => `${s.source}:${s.scope_key}`)).toEqual(['jira:jira:ALI', 'zoom:yours']);
    expect(r.text).toContain('Zoom: only your own');
  });

  it('refuses an unknown property before anything else, naming it and not its value', async () => {
    await expect(dispatchTool('align_scope', { action: 'view', token: 'ghp_SECRETVALUE0123456789' }, client, env)).rejects.toThrow(/"token"/);
    try { await dispatchTool('align_scope', { action: 'view', token: 'ghp_SECRETVALUE0123456789' }, client, env); } catch (e) { expect((e as Error).message).not.toContain('SECRETVALUE'); }
  });

  it('a hosted server refuses', async () => {
    await expect(dispatchTool('align_scope', { action: 'view' }, client, cloudEnv)).rejects.toThrow(/local graph/);
  });

  it('a frozen (--created-before) server refuses set and still allows view', async () => {
    const frozen = '2026-01-01T00:00:00.000Z';
    await expect(dispatchTool('align_scope', { action: 'set', source: 'jira', scope: 'yours' }, client, env, frozen)).rejects.toThrow(/frozen.*never changes scope/);
    expect(store.scopes['jira']).toBeDefined();
    const r = await dispatchTool('align_scope', { action: 'view' }, client, env, frozen) as { sources: unknown[] };
    expect(r.sources).toHaveLength(2);
  });

  it('set to yours goes through setScope: the team choice is replaced by an explicit yours', async () => {
    const r = await dispatchTool('align_scope', { action: 'set', source: 'jira', scope: 'yours' }, client, env) as { text: string; scope: string };
    expect(r.scope).toBe('yours');
    expect(store.scopes['jira']).toEqual({ kind: 'yours' });
  });
});
