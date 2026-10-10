import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

/**
 * L3: align_backfill as the agent sees it - on the tool list, behind the closed schema, in the
 * instructions, and through the real dispatcher. Nothing here touches a real vendor, a real
 * token or the real graph: the config store, the child process and the DB are doubles or temp.
 */
const spawnMock = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<object>()), spawn: spawnMock }));
const fields = vi.hoisted(() => ({ value: null as Record<string, string> | null }));
vi.mock('../lib/config.js', async (orig) => ({
  ...(await orig<object>()),
  createConfigStore: vi.fn(() => ({ getConnectorFields: vi.fn(() => fields.value) })),
}));

import { createLocalDb } from '../lib/local-db.js';
import { dispatchTool, instructionsFor, TOOL_SCHEMAS, toolSchemasFor } from '../commands/mcp.js';
import { BACKFILL_SOURCES } from '../lib/mcp-backfill.js';

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let env: EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: null } as EnvironmentConfig;
const client = {} as Parameters<typeof dispatchTool>[2];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-tool-'));
  const dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
  env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath };
  fields.value = { token: 'tok-in-store' };
  spawnMock.mockClear();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the tool on the list', () => {
  const tool = () => TOOL_SCHEMAS.find((t) => t.name === 'align_backfill') as unknown as {
    annotations: { readOnlyHint: boolean }; description: string;
    inputSchema: { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean };
  };

  it('is listed once, in both modes', () => {
    for (const e of [env, cloudEnv]) expect(toolSchemasFor(e).filter((t) => t.name === 'align_backfill')).toHaveLength(1);
  });

  it('is annotated as a write (it records a window and starts an import)', () => {
    expect(tool().annotations.readOnlyHint).toBe(false);
  });

  it('has a closed schema: source required, only source and since, and no property that could carry a secret', () => {
    expect(tool().inputSchema.additionalProperties).toBe(false);
    expect(tool().inputSchema.required).toEqual(['source']);
    expect(Object.keys(tool().inputSchema.properties).sort()).toEqual(['since', 'source']);
    expect(tool().inputSchema.properties['source']!.enum).toEqual([...BACKFILL_SOURCES]);
  });

  it('tells the agent what it does not do: no tokens, and the person connects', () => {
    expect(tool().description).toMatch(/never (takes|accepts) a token/i);
    expect(tool().description).toMatch(/align connect/);
  });
});

describe('the instructions', () => {
  it('local mode says when to offer it, and stays inside the 2048-character budget', () => {
    const text = instructionsFor(env);
    expect(text).toContain('align_backfill');
    expect(text.length).toBeLessThan(2048);
  });

  it('cloud mode does not name a tool it cannot serve', () => {
    expect(instructionsFor(cloudEnv)).not.toContain('align_backfill');
  });
});

describe('through the dispatcher', () => {
  it('a connected source starts one detached connect with this CLI\'s own entry point', async () => {
    const r = await dispatchTool('align_backfill', { source: 'github', since: '1y' }, client, env) as { started: boolean; text: string };
    expect(r.started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0] as unknown as [string, string[], { detached: boolean; stdio: string }];
    expect(call[0]).toBe(process.execPath);
    expect(call[1].slice(1)).toEqual(['connect', '--source', 'github', '--since', '1y', '--yes', '--json']);
    expect(call[2]).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(JSON.stringify(call)).not.toContain('tok-in-store');
  });

  it('records the window where L5 will read it', async () => {
    await dispatchTool('align_backfill', { source: 'github', since: '30d' }, client, env);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(env.localDbPath!);
    const row = db.prepare('SELECT window_since, changed_via FROM source_sync WHERE source_id = ?').get('github') as { window_since: string; changed_via: string };
    db.close();
    expect(row.changed_via).toBe('mcp');
    expect(Math.round((Date.now() - Date.parse(row.window_since)) / 86_400_000)).toBe(30);
  });

  it('a not-connected source starts nothing', async () => {
    fields.value = null;
    const r = await dispatchTool('align_backfill', { source: 'github' }, client, env) as { started: boolean; text: string };
    expect(r).toMatchObject({ started: false });
    expect(r.text).toContain('align connect github');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('a token property is rejected before anything runs', async () => {
    await expect(dispatchTool('align_backfill', { source: 'github', token: 'ghp_x' }, client, env)).rejects.toThrow(/token/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('a missing source is the dispatcher\'s own required-argument error', async () => {
    await expect(dispatchTool('align_backfill', {}, client, env)).rejects.toThrow(/requires "source"/);
  });

  it('a frozen (--created-before) server never backfills, like align_capture', async () => {
    await expect(dispatchTool('align_backfill', { source: 'github' }, client, env, '2026-01-01T00:00:00.000Z')).rejects.toThrow(/frozen.*never backfills/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
