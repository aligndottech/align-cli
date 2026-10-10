import { spawnSync } from 'node:child_process';
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
// A child that "starts": the 'spawn' event fires, and the pid is a live one (this process) so the
// cap can see it.
const spawnMock = vi.hoisted(() => vi.fn(() => ({
  pid: process.pid,
  on: (ev: string, cb: () => void) => { if (ev === 'spawn') queueMicrotask(cb); },
  unref: vi.fn(),
})));
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

const saved: Record<string, string | undefined> = {};
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
  // The state directory (status files) is scratch too, and so is the home a fallback would use.
  for (const k of ['XDG_STATE_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) saved[k] = process.env[k];
  process.env['XDG_STATE_HOME'] = dir; process.env['HOME'] = dir; process.env['USERPROFILE'] = dir; process.env['LOCALAPPDATA'] = dir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(dir, { recursive: true, force: true });
});

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
    expect(call[1].slice(1)).toEqual(['connect', '--env', 'local', '--source', 'github', '--since', '1y', '--yes', '--json']);
    expect(call[2]).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    // The status file the child will fill in lives in the (scratch) state directory.
    expect((call[2] as unknown as { env: Record<string, string> }).env['ALIGN_BACKFILL_STATUS']).toBe(path.join(dir, 'align-cli', 'backfill', 'github.json'));
    // L4: the child is marked as started by an agent's tool call, so any scope it writes waits for a person.
    expect((call[2] as unknown as { env: Record<string, string> }).env['ALIGN_STARTED_BY']).toBe('mcp');
    expect(JSON.stringify(call)).not.toContain('tok-in-store');
  });

  it('leaves a status file for the child it started, with the pid, for align_sync to find', async () => {
    await dispatchTool('align_backfill', { source: 'github' }, client, env);
    const file = path.join(dir, 'align-cli', 'backfill', 'github.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ source: 'github', pid: process.pid, state: 'running' });
  });

  it('a second backfill of the same source is refused while the first runs (the pid is alive)', async () => {
    await dispatchTool('align_backfill', { source: 'github' }, client, env);
    const r = await dispatchTool('align_backfill', { source: 'github', since: '1y' }, client, env) as { started: boolean; text: string };
    expect(r.started).toBe(false);
    expect(r.text).toMatch(/already running/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('a status file left by a child that died does not block the next one', async () => {
    const stale = path.join(dir, 'align-cli', 'backfill');
    fs.mkdirSync(stale, { recursive: true });
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    fs.writeFileSync(path.join(stale, 'github.json'), JSON.stringify({ source: 'github', pid: dead, started_at: '2026-10-01T00:00:00.000Z', state: 'running' }));
    const r = await dispatchTool('align_backfill', { source: 'github' }, client, env) as { started: boolean };
    expect(r.started).toBe(true);
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
