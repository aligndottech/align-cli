/**
 * ALI-1749: an agent reading align_ask / align_search gets an additive `reason` (the stated
 * reason extracted from the commit message, or null) and a `sha` for commit-backed rows.
 * Every existing field must pass through untouched. Asserted through the real handler and the
 * SERIALIZED text, because only that can tell a null from an absent key.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage: vi.fn().mockResolvedValue(true) }));

import { createCallToolHandler, type dispatchTool, toolSchemasFor } from '../commands/mcp.js';
import { commitShaOf, withReasons } from '../lib/reason-extract.js';

type Client = Parameters<typeof dispatchTool>[2];
const local: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'local-embedded' };
const cloud: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: 'x', mode: 'auth' };

const SHA = 'abc1234abc1234abc1234abc1234abc1234abc12';
const WITH_REASON = {
  id: 'id-1', title: 'fix: drop parser', similarity: 0.61, decided_at: '2024-05-01T10:00:00Z',
  source_url: `https://github.com/o/r/commit/${SHA}`, cite: 'r@abc1234', platform: 'git',
  summary: `fix: drop parser\n\nWe dropped it because it buffered whole bodies.\n\nAuthor: A\n\nDate: 2024-05-01T10:00:00Z\n\nFiles changed:\nlib/p.js\n\nURL: https://github.com/o/r/commit/${SHA}`,
};
const NO_REASON = { id: 'id-2', title: 'chore: bump x', similarity: 0.5, summary: 'chore: bump x', source_url: 'https://example.com/issue/9' };

const clientReturning = (results: unknown[]): Client =>
  ({ searchDecisions: vi.fn().mockResolvedValue({ results, count: results.length, strategy: 'semantic', scope: null }) }) as unknown as Client;

async function call(name: string, args: Record<string, unknown>, results: unknown[], env = local) {
  const handler = createCallToolHandler(clientReturning(results), env);
  const reply = await handler({ params: { name, arguments: args } });
  return JSON.parse(reply.content[0].text) as { results: Array<Record<string, unknown>> };
}

describe.each([['align_ask', { question: 'why drop parser' }], ['align_search', { query: 'why drop parser' }]])('%s result shape', (name, args) => {
  it('adds reason (string) and sha, keeps every existing field byte for byte', async () => {
    const out = await call(name, args, [WITH_REASON]);
    expect(out.results[0]).toEqual({ ...WITH_REASON, reason: 'We dropped it because it buffered whole bodies.', sha: SHA });
  });
  it('a row with no stated reason carries an explicit null, and no sha when the url is not a commit', async () => {
    const out = await call(name, args, [NO_REASON]);
    expect(out.results[0]).toEqual({ ...NO_REASON, reason: null });
    expect('sha' in out.results[0]).toBe(false);
  });
  it('carries sha, date, title, score and url for a commit hit', async () => {
    const r = (await call(name, args, [WITH_REASON])).results[0];
    expect([r['sha'], r['decided_at'], r['title'], r['similarity'], r['source_url']]).toEqual([SHA, '2024-05-01T10:00:00Z', 'fix: drop parser', 0.61, `https://github.com/o/r/commit/${SHA}`]);
  });
  it('works for cloud rows too (no summary at all gives null, no throw)', async () => {
    const out = await call(name, args, [{ id: 'c1', title: 'T' }], cloud);
    expect(out.results[0]).toEqual({ id: 'c1', title: 'T', reason: null });
  });
});

describe('withReasons / commitShaOf', () => {
  it('leaves a payload with no results array alone', () => {
    const p = { status: 'x' };
    expect(withReasons(p)).toBe(p);
  });
  it('passes a non-object row through untouched', () => {
    expect(withReasons({ results: [null, 'x', [1], 4] }).results).toEqual([null, 'x', [1], 4]);
  });
  it('does not mutate its input', () => {
    const p = { results: [{ ...WITH_REASON }] };
    withReasons(p, { sha: true });
    expect('reason' in p.results[0]).toBe(false);
  });
  it('sha from hosted, gitlab subgroup and remoteless commit urls; undefined otherwise', () => {
    expect(commitShaOf(`https://github.com/o/r/commit/${SHA}`)).toBe(SHA);
    expect(commitShaOf('https://gitlab.com/g/s/r/-/commit/abc1234')).toBe('abc1234');
    expect(commitShaOf(`git://commit/${SHA}`)).toBe(SHA);
    expect(commitShaOf('https://github.com/o/r/pull/4')).toBeUndefined();
    expect(commitShaOf(undefined)).toBeUndefined();
  });
});

describe('tool descriptions tell the agent what reason is', () => {
  it.each([['align_ask'], ['align_search']])('%s', (name) => {
    for (const env of [local, cloud]) {
      const d = toolSchemasFor(env).find((t) => t.name === name)!.description;
      expect(d).toContain('`reason`');
      expect(d).toMatch(/stated reason extracted from the commit message/);
      expect(d).toMatch(/may be null/);
    }
  });
});
