import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig } from '../lib/config';
import { instructionsFor, toolSchemasFor } from '../commands/mcp';

/**
 * Three Align MCP servers are commonly connected at once - align-prod, align-preview, and this
 * CLI running `align mcp --env local` - and their tool names are near-identical. Nothing in the
 * local server's instructions or descriptions said WHICH graph it reads, so an agent choosing
 * between them had no basis to choose, and reached for align_ask because the instructions named
 * it first.
 *
 * It then answered a question about the hosted product from a laptop's SQLite file holding four
 * seeded demo decisions, reported two unrelated hits, and went to grep. The agent was following
 * instructions correctly; the instructions were on the wrong server and did not say so.
 *
 * These pin the disambiguation the agent needs, on both sides - a fixture that only tested local
 * mode would pass against a hardcoded "local" string.
 */

const localEnv = { mode: 'local-embedded', gatewayUrl: '', localDbPath: '/tmp/x.db' } as unknown as EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't' } as unknown as EnvironmentConfig;

describe('the MCP server says which decision graph it reads', () => {
  it('tells the agent the graph is local to this machine in local-embedded mode', () => {
    const text = instructionsFor(localEnv);
    expect(text.toLowerCase()).toMatch(/local|this machine/);
  });

  // The other side of the rule. Without it, hardcoding the word "local" into the base
  // instructions would satisfy the test above and make the cloud server lie.
  it('does not describe a cloud graph as local', () => {
    const text = instructionsFor(cloudEnv);
    expect(text.toLowerCase()).not.toMatch(/on this machine|local decision graph/);
    // Positive control: the same builder DID produce the local wording for the other env,
    // so its absence here is the mode and not a builder that emits nothing.
    expect(instructionsFor(localEnv).toLowerCase()).toMatch(/on this machine|local decision graph/);
  });

  it('names the gateway host in cloud mode, so two cloud servers are distinguishable', () => {
    expect(instructionsFor(cloudEnv)).toContain('api.align.tech');
  });

  // The budget is the reason this is not just "append a paragraph". Claude Code truncates
  // server instructions around 2KB, and a truncated instruction block fails silently: the
  // agent simply never sees the lines that were cut.
  it.each([
    ['local-embedded', localEnv],
    ['cloud', cloudEnv],
  ])('stays inside the 2048-byte instruction budget in %s mode', (_label, env) => {
    expect(instructionsFor(env).length).toBeLessThan(2048);
  });
});

describe('the retrieval tools say which graph they search', () => {
  function askDescription(env: EnvironmentConfig): string {
    const ask = toolSchemasFor(env).find(t => t.name === 'align_ask');
    // Positive control: the tool exists at all before anything is asserted about its text.
    expect(ask).toBeDefined();
    return ask!.description;
  }

  it('marks align_ask as reading the local graph in local-embedded mode', () => {
    expect(askDescription(localEnv).toLowerCase()).toMatch(/local|this machine/);
  });

  it('does not mark align_ask as local in cloud mode', () => {
    expect(askDescription(cloudEnv).toLowerCase()).not.toMatch(/on this machine|local decision graph/);
  });

  it('leaves tools that do not read the graph unchanged across modes', () => {
    const local = toolSchemasFor(localEnv).find(t => t.name === 'align_capture');
    const cloud = toolSchemasFor(cloudEnv).find(t => t.name === 'align_capture');
    expect(local?.description).toBe(cloud?.description);
  });

  it('keeps the tool set identical across modes, so only wording differs', () => {
    expect(toolSchemasFor(localEnv).map(t => t.name)).toEqual(toolSchemasFor(cloudEnv).map(t => t.name));
  });
});
