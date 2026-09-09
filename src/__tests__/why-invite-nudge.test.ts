/**
 * ALI-938: the invite nudge inside `align ask` - both trigger moments, with git.ts mocked
 * so the result does not depend on whatever identity happens to be configured on the
 * machine running the suite (why.test.ts itself calls the real git.ts and never asserts
 * on this text, which is fine there; asserting on it needs a controlled identity).
 *
 * Test List:
 * 1. synthesized-answer path: shows the nudge when a shown decision's author differs
 *    from the local identity
 * 2. synthesized-answer path: no nudge when every shown decision is mine (or has no
 *    author at all)
 * 3. list-fallback path (no AI provider): shows the nudge under the same rule
 * 4. empty results, non-file query, other committers exist: shows the nudge
 * 5. empty results, non-file query, no other committers: no nudge
 * 6. empty results, file-path query: never checks committers, no nudge
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

const searchDecisions = vi.hoisted(() => vi.fn());
const listDecisions = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ searchDecisions, listDecisions })),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn().mockReturnValue({ gatewayUrl: 'http://localhost', authToken: 'tok' }),
    getDefaultEnv: vi.fn().mockReturnValue('prod'),
    getConnectorFields: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

const mockSynthesise = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } }));
vi.mock('../lib/local-llm.js', async (importActual) => ({
  ...(await importActual<typeof LocalLlm>()),
  synthesiseDetailed: mockSynthesise,
}));

const getGitIdentities = vi.hoisted(() => vi.fn().mockResolvedValue({ email: 'tom@align.tech', name: 'Tom Knee' }));
const hasOtherCommitters = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('../lib/git.js', () => ({ getGitIdentities, hasOtherCommitters }));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });

import { registerAskCommand } from '../commands/why.js';
import type * as LocalLlm from '../lib/local-llm.js';

async function runAsk(query = 'why postgres'): Promise<string> {
  output.length = 0;
  const program = new Command();
  registerAskCommand(program);
  await program.parseAsync(['node', 'align', 'ask', query]);
  return output.join('\n');
}

beforeEach(() => {
  output.length = 0;
  getGitIdentities.mockClear().mockResolvedValue({ email: 'tom@align.tech', name: 'Tom Knee' });
  hasOtherCommitters.mockClear().mockResolvedValue(false);
  searchDecisions.mockReset();
  listDecisions.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

const MY_DECISION = {
  id: 'd1', title: 'Chose Postgres', summary: 'My call.', status: 'active', similarity: 0.9,
  author: { email: 'tom@align.tech', name: 'Tom Knee' },
};
const THEIR_DECISION = {
  id: 'd2', title: 'Switched to JWT', summary: 'Their call.', status: 'active', similarity: 0.85,
  author: { email: 'dan@align.tech', name: 'Dan' },
};

describe('align ask - the invite nudge, synthesized-answer path', () => {
  it('shows the nudge when the answer came from someone else\'s decision', async () => {
    searchDecisions.mockResolvedValue({ results: [THEIR_DECISION], count: 1, strategy: 'semantic' as const });
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'Answer.' });
    const all = await runAsk();
    expect(all).toContain('align invite');
    expect(all).toMatch(/someone else/i);
  });

  it('shows no nudge when every shown decision is mine', async () => {
    searchDecisions.mockResolvedValue({ results: [MY_DECISION], count: 1, strategy: 'semantic' as const });
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'Answer.' });
    const all = await runAsk();
    expect(all).not.toContain('align invite');
  });

  it('shows no nudge when the decision carries no author at all', async () => {
    searchDecisions.mockResolvedValue({
      results: [{ id: 'd3', title: 'Untitled call', summary: 's', status: 'active' }],
      count: 1, strategy: 'semantic' as const,
    });
    mockSynthesise.mockResolvedValueOnce({ ok: true, text: 'Answer.' });
    const all = await runAsk();
    expect(all).not.toContain('align invite');
  });
});

describe('align ask - the invite nudge, list-fallback path (no AI provider)', () => {
  it('shows the nudge under the same someone-else rule', async () => {
    searchDecisions.mockResolvedValue({ results: [THEIR_DECISION], count: 1, strategy: 'semantic' as const });
    mockSynthesise.mockResolvedValueOnce({ ok: false, failure: { kind: 'no_provider' } });
    const all = await runAsk();
    expect(all).toContain('align invite');
  });

  it('shows no nudge when the list is entirely mine', async () => {
    searchDecisions.mockResolvedValue({ results: [MY_DECISION], count: 1, strategy: 'semantic' as const });
    mockSynthesise.mockResolvedValueOnce({ ok: false, failure: { kind: 'no_provider' } });
    const all = await runAsk();
    expect(all).not.toContain('align invite');
  });
});

describe('align ask - the invite nudge, empty-result path', () => {
  it('shows the nudge when nothing matched but the repo has other committers', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic' as const });
    hasOtherCommitters.mockResolvedValue(true);
    const all = await runAsk();
    expect(all).toContain('align invite');
    expect(all).toMatch(/other committers/i);
  });

  it('shows no nudge when nothing matched and there are no other committers', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic' as const });
    hasOtherCommitters.mockResolvedValue(false);
    const all = await runAsk();
    expect(all).not.toContain('align invite');
  });

  it('never checks committers, and shows no nudge, for a file-path query', async () => {
    searchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic' as const });
    hasOtherCommitters.mockResolvedValue(true);
    const all = await runAsk('src/auth/middleware.ts');
    expect(hasOtherCommitters).not.toHaveBeenCalled();
    expect(all).not.toContain('align invite');
  });
});
