import { describe, expect, it } from 'vitest';

import { TOOL_SCHEMAS, toolSchemasFor } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config';

/**
 * ALI-1063: every MCP tool this server publishes must say whether it is read-only, so a
 * client can tell `align_ask` from `align_capture` without a hand-maintained list.
 *
 * Why it matters concretely: AlignBench's align arm runs this server under the Claude Agent
 * SDK with `permissionMode: 'bypassPermissions'`, and the SDK's `allowedTools` does NOT gate
 * MCP tools (measured: 374 MCP calls in a run whose allowedTools held only Read/Grep/Glob).
 * The only safe way to deny the write tools is to DERIVE the deny list from annotations. A
 * consumer that has to hardcode which tools write is the "allowlist entry is a lie" shape in
 * architecture-boundaries.md - it goes stale the first time a tool is added.
 *
 * The classification mirrors connectors/mcp-align/src/mcpServer.ts, which is the canonical
 * vocabulary (READS / WRITES_ADDITIVE). There, exactly four tools write: rate_conflict,
 * check_drift, capture, connect. This server exposes two of them.
 *
 * Test List:
 * - every tool carries a boolean readOnlyHint (no tool unannotated - the fail-closed property)
 * - the write tools are annotated as writes: align_capture, and align_check_drift
 * - the read tools are annotated as reads: align_ask, and align_search
 * - the write set is exactly those two, so a new tool cannot be added unclassified
 * - toolSchemasFor's description rewriting preserves annotations in both modes
 */

const WRITE_TOOLS = ['align_capture', 'align_check_drift'] as const;

const localEnv = { mode: 'local-embedded', gatewayUrl: '', localDbPath: '/tmp/x.db' } as unknown as EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't' } as unknown as EnvironmentConfig;

describe('MCP tool read-only annotations', () => {
  it('publishes a boolean readOnlyHint on every tool', () => {
    // Positive control: there are tools to assert about at all.
    expect(TOOL_SCHEMAS.length).toBeGreaterThan(4);
    const unannotated = TOOL_SCHEMAS.filter(
      (t) => typeof t.annotations?.readOnlyHint !== 'boolean',
    ).map((t) => t.name);
    expect(
      unannotated,
      'every tool must declare readOnlyHint, or a deriving client cannot tell reads from writes',
    ).toEqual([]);
  });

  it('annotates align_capture as a write', () => {
    const t = TOOL_SCHEMAS.find((x) => x.name === 'align_capture');
    expect(t?.annotations?.readOnlyHint).toBe(false);
  });

  it('annotates align_check_drift as a write', () => {
    const t = TOOL_SCHEMAS.find((x) => x.name === 'align_check_drift');
    expect(t?.annotations?.readOnlyHint).toBe(false);
  });

  it('annotates align_ask as read-only', () => {
    const t = TOOL_SCHEMAS.find((x) => x.name === 'align_ask');
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it('annotates align_search as read-only', () => {
    const t = TOOL_SCHEMAS.find((x) => x.name === 'align_search');
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it('classifies exactly the known write tools, so a new tool cannot arrive unclassified', () => {
    const writes = TOOL_SCHEMAS.filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    expect(writes).toEqual([...WRITE_TOOLS].sort());
  });

  it.each([
    ['local-embedded', localEnv],
    ['cloud', cloudEnv],
  ])('preserves annotations through the %s description rewrite', (_label, env) => {
    for (const tool of toolSchemasFor(env)) {
      expect(
        typeof tool.annotations?.readOnlyHint,
        `${tool.name} lost its annotation in the rewrite`,
      ).toBe('boolean');
    }
  });
});
