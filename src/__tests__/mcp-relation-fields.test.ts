/**
 * ALI-1066 / ALI-1092, CLI half: what REPLACED a decision (`successor`) and what CONTESTS it
 * (`conflicts_with`) have to reach the agent through THIS server's tool output, in a shape an
 * agent can act on.
 *
 * The premise this suite was written against turned out to be wrong in an instructive way, and
 * it is recorded here rather than in a commit message nobody re-reads. `align mcp`'s search
 * arms do not project at all - `serializeMcpResult` is a DENYLIST, so a gateway row reaches the
 * agent verbatim (a prod probe on v0.30.0 returned `architectural_altitude`, `spaces`, `tier`
 * and `supersession_count`, none of which any line of this repo names). So "the CLI drops the
 * relation fields" was never true; pass-through already carried them.
 *
 * What pass-through gets WRONG is the absent-vs-null distinction, and that is the defect these
 * tests pin. `JSON.stringify` emits `"conflicts_with":null` for a null, and an agent reading
 * that has been told "no conflict exists" - a different claim from "not provided". Same for a
 * half-built relation with no `id`: it names an opponent the agent cannot go and read.
 *
 * Every assertion runs through `createCallToolHandler`, the handler `align mcp` installs, and
 * reads the SERIALIZED text. A helper tested in isolation cannot tell you the product calls it,
 * and only the serialized form can distinguish an absent key from an `undefined`-valued one.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { createCallToolHandler, type dispatchTool } from '../commands/mcp.js';

type Client = Parameters<typeof dispatchTool>[2];

const cloud: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: 'x', mode: 'auth' };
const local: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'local-embedded' };

/** The counterpart shape the gateway sends (db/decisionRelationAttachments.ts). */
const COUNTERPART = {
  id: 'c1',
  title: 'Allowlist 36 read-only MCP tools',
  source_url: 'https://github.com/aligndottech/align-cli/pull/281',
  relation: 'conflicts_with',
};
const SUCCESSOR = {
  id: 's1',
  title: 'Publish readOnlyHint annotations on all MCP tools',
  source_url: 'https://github.com/aligndottech/align-cli/pull/293',
  relation: 'supersedes',
};

function clientReturning(results: unknown[]): Client {
  return {
    searchDecisions: vi.fn().mockResolvedValue({ results, count: results.length, strategy: 'keyword' }),
  } as unknown as Client;
}

/** Run the real MCP CallTool handler and give back both the text and the parsed payload. */
async function callSearch(
  c: Client,
  env: EnvironmentConfig = cloud,
  name = 'align_search',
): Promise<{ text: string; rows: Array<Record<string, unknown>> }> {
  const handler = createCallToolHandler(c, env);
  // Both names: align_search requires `query`, align_ask requires `question`, and the
  // required-argument guard in dispatchTool rejects the call before any of this runs
  // otherwise - a RED on that guard would be a RED for the wrong reason.
  const out = await handler({
    params: { name, arguments: { query: 'mcp tool annotations', question: 'mcp tool annotations', limit: 5 } },
  });
  const text = out.content[0]!.text;
  const payload = JSON.parse(text) as { results?: Array<Record<string, unknown>> };
  // A zero-match parse is not data: every assertion below is about a row, so prove there is one.
  expect(Array.isArray(payload.results)).toBe(true);
  return { text, rows: payload.results! };
}

describe('MCP search relation fields (successor / conflicts_with)', () => {
  it('surfaces conflicts_with on a conflicted decision, dropping a null field rather than emitting it', async () => {
    const c = clientReturning([
      { id: 'd1', title: 'Publish readOnlyHint annotations', summary: 's', status: 'conflicted',
        conflicts_with: { ...COUNTERPART, source_url: null } },
    ]);
    const { text, rows } = await callSearch(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['conflicts_with']).toEqual({
      id: 'c1',
      title: 'Allowlist 36 read-only MCP tools',
      relation: 'conflicts_with',
    });
    // The serialized form is the agent's actual input - a null must not survive into it.
    expect(text).not.toContain('"source_url":null');
  });

  it('surfaces successor on a conflicted decision, same normalisation', async () => {
    const c = clientReturning([
      { id: 'd1', title: 'Allowlist 36 read-only MCP tools', summary: 's', status: 'conflicted',
        successor: { ...SUCCESSOR, title: null } },
    ]);
    const { text, rows } = await callSearch(c);
    expect(rows[0]!['successor']).toEqual({
      id: 's1',
      source_url: 'https://github.com/aligndottech/align-cli/pull/293',
      relation: 'supersedes',
    });
    expect(text).not.toContain('"title":null');
  });

  /**
   * NEGATIVE CONTROL. Without it a projection that attaches unconditionally passes every
   * other test in this file - the field would be present on every row and never wrong.
   */
  it('an ACTIVE decision carries neither field', async () => {
    const c = clientReturning([{ id: 'd1', title: 'Use Postgres', summary: 's', status: 'active' }]);
    const { text, rows } = await callSearch(c);
    expect(rows[0]).not.toHaveProperty('conflicts_with');
    expect(rows[0]).not.toHaveProperty('successor');
    expect(text).not.toContain('conflicts_with');
    expect(text).not.toContain('successor');
  });

  it('a gateway response that omits the fields produces output with the keys ABSENT, not null', async () => {
    const c = clientReturning([{ id: 'd1', title: 'Use Postgres', summary: 's', status: 'conflicted' }]);
    const { text, rows } = await callSearch(c);
    expect(Object.keys(rows[0]!)).toEqual(['id', 'title', 'summary', 'status']);
    expect(text).not.toContain('null');
  });

  it('a NULL relation from the gateway is dropped - "no conflict exists" is a different claim from "not provided"', async () => {
    const c = clientReturning([
      { id: 'd1', title: 'X', summary: 's', status: 'conflicted', conflicts_with: null, successor: null },
    ]);
    const { text, rows } = await callSearch(c);
    expect(rows[0]).not.toHaveProperty('conflicts_with');
    expect(rows[0]).not.toHaveProperty('successor');
    expect(text).not.toContain('"conflicts_with":null');
    expect(text).not.toContain('"successor":null');
  });

  it('a relation with no id is dropped whole - an opponent the agent cannot go and read is worse than silence', async () => {
    const c = clientReturning([
      { id: 'd1', title: 'X', summary: 's', status: 'conflicted', conflicts_with: { title: 'Something', relation: 'conflicts_with' } },
    ]);
    const { rows } = await callSearch(c);
    expect(rows[0]).not.toHaveProperty('conflicts_with');
  });

  it('leaves every other gateway field untouched - this arm is a pass-through and stays one', async () => {
    const c = clientReturning([
      { id: 'd1', title: 'X', summary: 's', status: 'conflicted', architectural_altitude: 'system',
        spaces: [{ id: 'sp1' }], tier: 2, conflict_count: 1, conflicts_with: COUNTERPART },
    ]);
    const { rows } = await callSearch(c);
    expect(rows[0]!['architectural_altitude']).toBe('system');
    expect(rows[0]!['spaces']).toEqual([{ id: 'sp1' }]);
    expect(rows[0]!['tier']).toBe(2);
    expect(rows[0]!['conflict_count']).toBe(1);
    expect(rows[0]!['conflicts_with']).toEqual(COUNTERPART);
  });

  /**
   * The two pass-through limbs, pinned rather than left as living mutants. Both are reachable:
   * a gateway error body has no `results` at all, and a row is whatever the gateway put in the
   * array. Neither may throw - a malformed page must still reach the agent as the gateway sent
   * it, because a thrown tool call tells the agent nothing about the graph.
   */
  it('a payload with no results array passes through untouched', async () => {
    const c = { searchDecisions: vi.fn().mockResolvedValue({ error: 'upstream 500', count: 0 }) } as unknown as Client;
    const handler = createCallToolHandler(c, cloud);
    const out = await handler({ params: { name: 'align_search', arguments: { query: 'q' } } });
    expect(JSON.parse(out.content[0]!.text)).toEqual({ error: 'upstream 500', count: 0 });
  });

  it('a non-object row passes through untouched', async () => {
    const c = clientReturning([null, 'not-a-row', 42]);
    const { rows } = await callSearch(c);
    expect(rows).toEqual([null, 'not-a-row', 42]);
  });

  it('align_ask and align_get_related_decisions get the same treatment - one agent, one contract', async () => {
    for (const tool of ['align_ask', 'align_get_related_decisions']) {
      const c = clientReturning([
        { id: 'd1', title: 'X', summary: 's', status: 'conflicted', conflicts_with: null, successor: SUCCESSOR },
      ]);
      const handler = createCallToolHandler(c, cloud);
      const out = await handler({ params: { name: tool, arguments: { question: 'q', query: 'q', file_path: 'a.ts' } } });
      const rows = (JSON.parse(out.content[0]!.text) as { results: Array<Record<string, unknown>> }).results;
      expect(rows, `${tool} returned no rows`).toHaveLength(1);
      expect(rows[0], tool).not.toHaveProperty('conflicts_with');
      expect(rows[0]!['successor'], tool).toEqual(SUCCESSOR);
    }
  });

  /**
   * LOCAL MODE, contract half. The real thing - the actual SQLite-backed client, with a genuine
   * `conflicts_with` edge on disk - is pinned in mcp-relation-fields-local.test.ts, because a
   * fake client only proves what this file authored it to return. This case pins the other half:
   * a local-shaped row passing through the same dispatch acquires nothing it did not arrive with.
   */
  it('local mode emits neither field, because local search never reads the link table', async () => {
    const c = clientReturning([
      { id: 'd1', title: 'Use Postgres', summary: 's', similarity: 0.9, platform: 'git' },
    ]);
    const { text, rows } = await callSearch(c, local, 'align_ask');
    expect(rows[0]).not.toHaveProperty('conflicts_with');
    expect(rows[0]).not.toHaveProperty('successor');
    expect(text).not.toContain('conflicts_with');
    expect(text).not.toContain('successor');
    // Positive control: the local row really did arrive, so the absences above mean something.
    expect(rows[0]!['similarity']).toBe(0.9);
  });
});
