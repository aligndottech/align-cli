import { describe, expect, it, vi } from 'vitest';
import { dispatchTool } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';

// The MCP CallTool dispatch is the agent's integration point - every tool call an
// IDE agent makes routes through here. It was previously inlined in the request
// handler with zero tests. dispatchTool is the extracted pure router.
function fakeClient() {
  return {
    searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }),
    captureDecision: vi.fn().mockResolvedValue({ id: 'd1' }),
    checkAlignment: vi.fn().mockResolvedValue({ status: 'no-context' }),
    checkDrift: vi.fn().mockResolvedValue({}),
    getImpact: vi.fn().mockResolvedValue({}),
    getConflicts: vi.fn().mockResolvedValue({ links: [] }),
  };
}
type Client = Parameters<typeof dispatchTool>[2];
const cast = (c: ReturnType<typeof fakeClient>) => c as unknown as Client;

const cloud: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'auth' };
const local: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'local-embedded' };

describe('dispatchTool (MCP CallTool routing)', () => {
  it('align_search routes to searchDecisions with the query + limit', async () => {
    const c = fakeClient();
    await dispatchTool('align_search', { query: 'auth', limit: 3 }, cast(c), cloud);
    expect(c.searchDecisions).toHaveBeenCalledWith('auth', 3);
  });

  it('align_ask defaults the limit to 8', async () => {
    const c = fakeClient();
    await dispatchTool('align_ask', { question: 'why postgres' }, cast(c), cloud);
    expect(c.searchDecisions).toHaveBeenCalledWith('why postgres', 8);
  });

  it('align_get_related_decisions combines file_path + context at limit 5', async () => {
    const c = fakeClient();
    await dispatchTool('align_get_related_decisions', { file_path: 'src/auth.ts', context: 'jwt' }, cast(c), cloud);
    expect(c.searchDecisions).toHaveBeenCalledWith('src/auth.ts jwt', 5);
  });

  it.each([
    ['https://acme.slack.com/archives/C1/p123', 'slack'],
    ['https://acme.atlassian.net/browse/ABC-1', 'jira'],
    ['https://acme.atlassian.net/wiki/spaces/X/pages/1', 'confluence'],
    ['https://github.com/o/r/pull/1', 'github'],
    ['https://linear.app/acme/issue/ABC-1', 'linear'],
    ['https://example.com/some/doc', 'web'],
  ])('align_capture classifies %s as %s', async (url, platform) => {
    const c = fakeClient();
    await dispatchTool('align_capture', { input: url }, cast(c), cloud);
    expect(c.captureDecision).toHaveBeenCalledWith(url, platform);
  });

  it('align_capture rejects raw text in cloud mode', async () => {
    const c = fakeClient();
    await expect(dispatchTool('align_capture', { input: 'we chose postgres' }, cast(c), cloud)).rejects.toThrow(/requires a URL/);
    expect(c.captureDecision).not.toHaveBeenCalled();
  });

  it('align_capture accepts raw text in local mode (platform cli)', async () => {
    const c = fakeClient();
    await dispatchTool('align_capture', { input: 'we chose postgres' }, cast(c), local);
    expect(c.captureDecision).toHaveBeenCalledWith('we chose postgres', 'cli');
  });

  it('align_check_alignment routes the diff + context', async () => {
    const c = fakeClient();
    await dispatchTool('align_check_alignment', { diff: 'd', context: 'branch' }, cast(c), cloud);
    expect(c.checkAlignment).toHaveBeenCalledWith('d', 'branch');
  });

  it('align_get_conflicts routes to getConflicts', async () => {
    const c = fakeClient();
    await dispatchTool('align_get_conflicts', {}, cast(c), cloud);
    expect(c.getConflicts).toHaveBeenCalled();
  });

  it('throws on an unknown tool', async () => {
    const c = fakeClient();
    await expect(dispatchTool('align_bogus', {}, cast(c), cloud)).rejects.toThrow(/Unknown tool/);
  });
});