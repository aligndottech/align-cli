// ALI-1494: the MCP call log. With ALIGN_LLM_TRACE_FILE set, every tool call `align mcp` handles
// appends one row to the same local file the chat trace uses: the tool name, its arguments, the
// result (or the error), the calling client when it said who it is, and the duration. Local only,
// never sent, off by default, owner-only. Nothing here adds a network call or a telemetry event.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage: vi.fn().mockResolvedValue(true) }));

import { createCallToolHandler, type dispatchTool } from '../commands/mcp.js';

type Client = Parameters<typeof dispatchTool>[2];

const env: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };

const HIT = { id: 'd1', title: 'Chose Postgres', summary: 'JSONB', status: 'active', similarity: 0.9 };

function client(over: Record<string, unknown> = {}): Client {
  return {
    searchDecisions: vi.fn().mockResolvedValue({ results: [HIT], count: 1, strategy: 'semantic' }),
    ...over,
  } as unknown as Client;
}

let dir: string;
let traceFile: string;

beforeEach(() => {
  vi.stubEnv('ALIGN_LLM_TRACE_FILE', undefined);
  dir = mkdtempSync(join(tmpdir(), 'align-mcp-trace-'));
  traceFile = join(dir, 'trace.jsonl');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const rows = () => readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);

describe('MCP call log (ALIGN_LLM_TRACE_FILE)', () => {
  it('is off by default: no file is written, and the call still answers', async () => {
    const out = await createCallToolHandler(client(), env)({ params: { name: 'align_ask', arguments: { question: 'why postgres' } } });
    expect(out.content[0].text).toContain('Chose Postgres'); // positive control: the call worked
    expect(existsSync(traceFile)).toBe(false);
  });

  it('appends one row per call: tool, arguments, the result text, duration and a timestamp', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);

    await createCallToolHandler(client(), env)({ params: { name: 'align_ask', arguments: { question: 'why postgres', limit: 3 } } });

    const [row] = rows();
    expect(row).toMatchObject({ kind: 'mcp_call', tool: 'align_ask', ok: true, args: { question: 'why postgres', limit: 3 } });
    expect(row.result).toContain('Chose Postgres');
    expect(typeof row.durationMs).toBe('number');
    expect(Number.isNaN(Date.parse(row.ts))).toBe(false);
  });

  it('records the calling client when the client said who it is, and null when it did not', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);

    await createCallToolHandler(client(), env, undefined, { clientInfo: () => ({ name: 'claude-code', version: '2.1.0' }) })({
      params: { name: 'align_ask', arguments: { question: 'q' } },
    });
    await createCallToolHandler(client(), env)({ params: { name: 'align_ask', arguments: { question: 'q' } } });

    const written = rows();
    expect(written[0].client).toEqual({ name: 'claude-code', version: '2.1.0' });
    expect(written[1].client).toBeNull();
  });

  it('records a failing call with its error message, then rethrows so the caller still sees it', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    const failing = client({ searchDecisions: vi.fn().mockRejectedValue(new Error('gateway down')) });

    await expect(
      createCallToolHandler(failing, env)({ params: { name: 'align_ask', arguments: { question: 'q' } } }),
    ).rejects.toThrow('gateway down');

    const [row] = rows();
    expect(row).toMatchObject({ kind: 'mcp_call', tool: 'align_ask', ok: false, error: 'gateway down' });
    expect(row).not.toHaveProperty('result');
  });

  it('records an unknown tool as a failed call', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    await expect(createCallToolHandler(client(), env)({ params: { name: 'no_such_tool', arguments: {} } })).rejects.toThrow(/Unknown tool/);
    expect(rows()[0]).toMatchObject({ tool: 'no_such_tool', ok: false });
  });

  it.skipIf(process.platform === 'win32')('creates the file readable by its owner only', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    await createCallToolHandler(client(), env)({ params: { name: 'align_ask', arguments: { question: 'q' } } });
    expect(statSync(traceFile).mode & 0o777).toBe(0o600);
  });

  it('does not break the call when the file cannot be written', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', join(dir, 'no-such-dir', 'deeper', 'trace.jsonl'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = await createCallToolHandler(client(), env)({ params: { name: 'align_ask', arguments: { question: 'q' } } });

    expect(out.content[0].text).toContain('Chose Postgres');
    warn.mockRestore();
  });

  it('adds no network call: the handler touches no fetch of its own with the trace on', async () => {
    vi.stubEnv('ALIGN_LLM_TRACE_FILE', traceFile);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await createCallToolHandler(client(), env)({ params: { name: 'align_ask', arguments: { question: 'q' } } });

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
