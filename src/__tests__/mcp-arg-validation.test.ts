import { describe, expect, it, vi } from 'vitest';
import { dispatchTool } from '../commands/mcp.js';
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
