import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createLocalDb } from '../lib/local-db.js';
import { dispatchTool, toolSchemasFor, wireCallTool } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { applyJudgement, contextKeyFor } from '../lib/curation/mark.js';
import { MARK_TOOL, runMarkTool } from '../lib/mcp/mark-tool.js';

/**
 * LM Test List (align_mark):
 * - Through a real initialize handshake: a verdict on a pair is a conflict_verdict, via mcp, agent_id = the registry id of clientInfo.name.
 * - check_files make a check_verdict keyed on those files.
 * - An unknown client name is stored as 'unknown' and the raw name appears nowhere in the file.
 * - A verdict outside real|false, an unknown id, both shapes at once, and neither shape are tool errors with no row.
 * - An extra `token` property is refused by name, its value is not echoed, no row.
 * - kind ratify is refused with the command for the user, and nothing is ratified.
 * - supersede, not_a_decision and note work; the same call twice leaves one row (notes append).
 * - A hosted server and a frozen (--created-before) server refuse; the CLI and the tool write the same row but for via and agent_id.
 */
let dir: string;
let dbPath: string;
let ids: Record<string, string>;
let env: EnvironmentConfig;
const judge = async () => ({ judgeId: 'inst-me', judgeLabel: null });

const rows = (sql = 'SELECT * FROM local_judgements ORDER BY rowid') => { const d = new DatabaseSync(dbPath); try { return d.prepare(sql).all() as Array<Record<string, unknown>>; } finally { d.close(); } };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lm-mcp-'));
  dbPath = path.join(dir, 'graph.db');
  const db = createLocalDb(dbPath);
  ids = {};
  for (const t of ['alpha', 'bravo']) ids[t] = db.insertDecision({ title: `${t} decision`, summary: t, sourceUrl: `https://example.com/${t}`, platform: 'cli' });
  db.close();
  env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath } as EnvironmentConfig;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A real in-process MCP session, so clientInfo travels the way it does from an agent. */
async function connect(clientName: string, e: EnvironmentConfig = env, createdBefore?: string) {
  const server = new Server({ name: 'align', version: '0' }, { capabilities: { tools: {} } });
  wireCallTool(server, {} as never, e, createdBefore, judge);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '9.9.9' }, { capabilities: {} });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: MARK_TOOL, arguments: args });
    return JSON.parse((res.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
  };
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

describe('attribution through a real handshake', () => {
  it('a pair verdict from claude-code is a conflict_verdict, via mcp, agent_id claude-code', async () => {
    const s = await connect('claude-code');
    const r = await s.call({ decision_id: ids.alpha, counterpart_id: ids.bravo, verdict: 'false' });
    expect(r['recorded']).toBe(true);
    expect(rows()).toMatchObject([{ kind: 'conflict_verdict', value: 'false', via: 'mcp', agent_id: 'claude-code', judge_id: 'inst-me' }]);
    await s.close();
  });
  it('a second registry agent is recorded under its own id (codex-mcp-client -> codex)', async () => {
    const s = await connect('codex-mcp-client');
    await s.call({ decision_id: ids.alpha, kind: 'not_a_decision' });
    expect(rows()).toMatchObject([{ via: 'mcp', agent_id: 'codex' }]);
    await s.close();
  });
  it('an unknown client name is stored as unknown and the raw name is nowhere in the file', async () => {
    const s = await connect('my-agent 9.9');
    await s.call({ decision_id: ids.alpha, kind: 'not_a_decision' });
    expect(rows()).toMatchObject([{ via: 'mcp', agent_id: 'unknown' }]);
    await s.close();
    expect(fs.readFileSync(dbPath).includes('my-agent')).toBe(false);
  });
});

describe('shapes', () => {
  const call = (args: Record<string, unknown>, e = env) => runMarkTool(args, e, { clientInfo: { name: 'claude-code' }, judge });

  it('check_files make a check_verdict keyed on the sorted set', async () => {
    await call({ decision_id: ids.alpha, verdict: 'false', check_files: ['y.ts', 'x.ts'] });
    expect(rows()).toMatchObject([{ kind: 'check_verdict', value: 'false', context_key: contextKeyFor(['x.ts', 'y.ts']), agent_id: 'claude-code' }]);
  });
  it('a verdict outside real|false is a tool error and stores nothing (two values)', async () => {
    await expect(call({ decision_id: ids.alpha, counterpart_id: ids.bravo, verdict: 'maybe' })).rejects.toThrow(/"verdict" must be one of: real, false/);
    await expect(call({ decision_id: ids.alpha, counterpart_id: ids.bravo, verdict: 'FALSE' })).rejects.toThrow(/"verdict"/);
    expect(rows()).toEqual([]);
  });
  it('neither counterpart_id nor check_files names the two accepted shapes; so does giving both', async () => {
    await expect(call({ decision_id: ids.alpha, verdict: 'false' })).rejects.toThrow(/check hit.*stored conflict/s);
    await expect(call({ decision_id: ids.alpha, verdict: 'false', counterpart_id: ids.bravo, check_files: ['x.ts'] })).rejects.toThrow(/check hit.*stored conflict/s);
    expect(rows()).toEqual([]);
  });
  it('an empty check_files is not a file set', async () => {
    await expect(call({ decision_id: ids.alpha, verdict: 'false', check_files: [] })).rejects.toThrow(/check hit.*stored conflict/s);
  });
  it('an unknown decision id is a tool error naming it', async () => {
    await expect(call({ decision_id: 'nope-123', kind: 'not_a_decision' })).rejects.toThrow(/nope-123/);
    expect(rows()).toEqual([]);
  });
  it('supersede writes the judgement and the link; the same call twice leaves one of each', async () => {
    await call({ decision_id: ids.alpha, kind: 'supersede', counterpart_id: ids.bravo });
    await call({ decision_id: ids.alpha, kind: 'supersede', counterpart_id: ids.bravo });
    expect(rows()).toHaveLength(1);
    expect(rows(`SELECT * FROM decision_links WHERE relation = 'supersedes'`)).toHaveLength(1);
    await expect(call({ decision_id: ids.alpha, kind: 'supersede' })).rejects.toThrow(/counterpart_id/);
  });
  it('a note appends: two calls, two rows; a note needs text', async () => {
    await call({ decision_id: ids.alpha, kind: 'note', text: 'one' });
    await call({ decision_id: ids.alpha, kind: 'note', text: 'two' });
    expect(rows().map((r) => r['note'])).toEqual(['one', 'two']);
    await expect(call({ decision_id: ids.alpha, kind: 'note' })).rejects.toThrow(/text/);
    await expect(call({ decision_id: ids.alpha, kind: 'note', text: 'x'.repeat(2001) })).rejects.toThrow(/at most 2000/);
  });
  it('a property that does not belong to the kind is refused (verdict on a note)', async () => {
    await expect(call({ decision_id: ids.alpha, kind: 'note', text: 't', verdict: 'false' })).rejects.toThrow(/does not take "verdict"/);
    await expect(call({ decision_id: ids.alpha, kind: 'not_a_decision', text: 't' })).rejects.toThrow(/does not take "text"/);
  });
});

describe('what an agent may not do', () => {
  it('a token or key is refused by name, its value is never echoed, and nothing is stored (two examples)', async () => {
    for (const bad of [{ token: 'ghp_SECRETVALUE0123456789' }, { api_key: 'sk-ant-SECRETVALUE' }]) {
      let message = '';
      try { await runMarkTool({ decision_id: ids.alpha, kind: 'not_a_decision', ...bad }, env, { judge }); } catch (e) { message = (e as Error).message; }
      expect(message).toContain(`"${Object.keys(bad)[0]}"`);
      expect(message).not.toContain('SECRETVALUE');
    }
    expect(rows()).toEqual([]);
  });
  it('cannot ratify: kind ratify gives the user the command and ratifies nothing', async () => {
    await expect(runMarkTool({ decision_id: ids.alpha, kind: 'ratify' }, env, { judge })).rejects.toThrow(`align ratify ${ids.alpha}`);
    expect(rows()).toEqual([]);
    expect(rows('SELECT ratified_by FROM decisions WHERE ratified_by IS NOT NULL')).toEqual([]);
  });
  it('a hosted server refuses (the judgement belongs to the local graph)', async () => {
    const hosted = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: null } as EnvironmentConfig;
    await expect(runMarkTool({ decision_id: ids.alpha, kind: 'not_a_decision' }, hosted, { judge })).rejects.toThrow(/hosted/);
  });
  it('a frozen server (--created-before) refuses to record', async () => {
    await expect(dispatchTool(MARK_TOOL, { decision_id: ids.alpha, kind: 'not_a_decision' }, {} as never, env, '2026-01-01')).rejects.toThrow(/frozen/);
    expect(rows()).toEqual([]);
  });
});

describe('one writer for the CLI and the tool', () => {
  it('the same mark through each surface is the same row but for via, agent_id, id and time', async () => {
    applyJudgement({ dbPath, judge: { judgeId: 'cli-judge', judgeLabel: null }, origin: { via: 'cli' } }, { action: 'conflict', a: ids.alpha, b: ids.bravo, verdict: 'false' });
    await runMarkTool({ decision_id: ids.alpha, counterpart_id: ids.bravo, verdict: 'false' }, env, { clientInfo: { name: 'opencode' }, judge: async () => ({ judgeId: 'mcp-judge', judgeLabel: null }) });
    const strip = (r: Record<string, unknown>) => { const { id, judged_at, via, agent_id, judge_id, ...rest } = r; void id; void judged_at; void via; void agent_id; void judge_id; return rest; };
    const [cli, mcp] = rows();
    expect(strip(cli)).toEqual(strip(mcp));
    expect([cli['via'], cli['agent_id'], mcp['via'], mcp['agent_id']]).toEqual(['cli', null, 'mcp', 'opencode']);
  });
});

describe('the tool is advertised', () => {
  it('is in the tool list with a closed schema and tells the agent to ask the user first', () => {
    const tool = toolSchemasFor(env).find((t) => t.name === MARK_TOOL) as { description: string; inputSchema: { additionalProperties: boolean; required: string[] } } | undefined;
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.additionalProperties).toBe(false);
    expect(tool!.inputSchema.required).toEqual(['decision_id']);
    expect(tool!.description).toContain('Was that a real conflict?');
    expect(tool!.description).toContain('align ratify');
  });
  it('is not routed to the gateway client: dispatch reaches the local handler', async () => {
    const spy = vi.fn();
    await expect(dispatchTool(MARK_TOOL, { decision_id: ids.alpha, kind: 'bogus' }, { searchDecisions: spy } as never, env)).rejects.toThrow(/"kind" must be one of/);
    expect(spy).not.toHaveBeenCalled();
  });
});
