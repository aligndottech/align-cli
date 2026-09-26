import { describe, expect, it, vi } from 'vitest';
import { dispatchTool, validateCreatedBeforeFlag } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';

/**
 * A tool call missing a required argument reached the implementation anyway, so
 * the failure surfaced from wherever the undefined happened to land. Calling
 * align_check_alignment without `diff` produced
 * `text may not be null or undefined` out of the tokenizer, raised to the agent
 * as JSON-RPC -32603. An agent cannot act on that: it names nothing it passed
 * and nothing it could pass instead.
 *
 * The required set is read from TOOL_SCHEMAS, the same declaration the agent is
 * given in tools/list, so there is one writer of "what this tool needs" rather
 * than a hand-kept second copy that can drift from the schema.
 */

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
const env: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'auth' };

describe('dispatchTool required-argument validation', () => {
  it('rejects align_check_alignment with no diff, naming the argument', async () => {
    const c = fakeClient();
    await expect(dispatchTool('align_check_alignment', {}, cast(c), env)).rejects.toThrow(/diff/);
    expect(c.checkAlignment).not.toHaveBeenCalled();
  });

  // Second example for the same rule, on a different tool and a different
  // argument name, so this cannot be a diff-shaped special case.
  it('rejects align_search with no query, naming the argument', async () => {
    const c = fakeClient();
    await expect(dispatchTool('align_search', {}, cast(c), env)).rejects.toThrow(/query/);
    expect(c.searchDecisions).not.toHaveBeenCalled();
  });

  it('rejects a blank string as well as a missing one', async () => {
    const c = fakeClient();
    await expect(dispatchTool('align_check_alignment', { diff: '   ' }, cast(c), env)).rejects.toThrow(/diff/);
    expect(c.checkAlignment).not.toHaveBeenCalled();
  });

  it('names every missing argument when a tool requires more than one', async () => {
    const c = fakeClient();
    await expect(dispatchTool('align_check_drift', {}, cast(c), env)).rejects.toThrow(/decision_id/);
    await expect(dispatchTool('align_check_drift', { decision_id: 'd1' }, cast(c), env)).rejects.toThrow(/content/);
    expect(c.checkDrift).not.toHaveBeenCalled();
  });

  // Control: a valid call must still dispatch. Without this, a validator that
  // rejected everything would pass every test above.
  it('dispatches normally when the required argument is present', async () => {
    const c = fakeClient();
    await dispatchTool('align_check_alignment', { diff: 'switch to MongoDB' }, cast(c), env);
    expect(c.checkAlignment).toHaveBeenCalledWith('switch to MongoDB', undefined);
  });

  // Control: the required set is derived from the schema, not applied blanket.
  // align_get_conflicts declares no required arguments and must still work with
  // no arguments at all.
  it('allows a tool that declares no required arguments to be called bare', async () => {
    const c = fakeClient();
    await dispatchTool('align_get_conflicts', undefined, cast(c), env);
    expect(c.getConflicts).toHaveBeenCalled();
  });
});

// ALI-1082: --created-before is harness/audit-only. Fail closed at startup, before the MCP
// server ever connects, rather than silently accepting a value that does nothing.
describe('validateCreatedBeforeFlag', () => {
  const cloudEnv: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'auth' };
  const localEnv: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'local-embedded' };

  // ALI-1087: local-embedded mode used to reject --created-before outright ("there is no
  // cutoff concept locally"), which described the implementation rather than a real limit -
  // the local graph stores a real created_at on every decision and edge, so the bound is
  // exactly as honourable there as it is against the cloud gateway.
  it('accepts a valid offset-bearing ISO timestamp in local-embedded mode too', () => {
    expect(() => validateCreatedBeforeFlag('2026-08-11T00:00:00.000Z', localEnv)).not.toThrow();
  });

  // Second example for the same rule: the format check still applies in local-embedded mode,
  // so this cannot be "local-embedded skips validation entirely".
  it('still rejects a bare date with no time/offset in local-embedded mode', () => {
    expect(() => validateCreatedBeforeFlag('2026-08-11', localEnv)).toThrow(/--created-before/);
  });

  it('rejects a bare date with no time/offset, the shape the corpus carries', () => {
    expect(() => validateCreatedBeforeFlag('2026-08-11', cloudEnv)).toThrow(/--created-before/);
  });

  it('rejects a non-date string', () => {
    expect(() => validateCreatedBeforeFlag('yesterday', cloudEnv)).toThrow(/--created-before/);
  });

  it('accepts an offset-bearing ISO timestamp in a non-local env', () => {
    expect(() => validateCreatedBeforeFlag('2026-08-11T00:00:00.000Z', cloudEnv)).not.toThrow();
  });

  // ALI-1082 (Copilot #302): the shape-only regex matched digits-in-the-right-places
  // without checking they form a real calendar instant. JS silently rolls a non-existent
  // day into the next month (Date.parse('2026-02-31...') -> March 3) rather than
  // rejecting it, so the regex alone let a corrupted cutoff through the fail-closed gate.
  it('rejects a calendar-invalid date (February 31st), not just a shape mismatch', () => {
    expect(() => validateCreatedBeforeFlag('2026-02-31T00:00:00.000Z', cloudEnv)).toThrow(/--created-before/);
  });

  // Second example for the same rule (leap-year boundary), so the fix cannot be a
  // February-specific special case.
  it('rejects February 29th in a non-leap year, accepts it in a leap year', () => {
    expect(() => validateCreatedBeforeFlag('2023-02-29T00:00:00.000Z', cloudEnv)).toThrow(/--created-before/);
    expect(() => validateCreatedBeforeFlag('2024-02-29T00:00:00.000Z', cloudEnv)).not.toThrow();
  });
});
