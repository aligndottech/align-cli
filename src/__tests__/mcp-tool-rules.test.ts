import { describe, expect, it } from 'vitest';
import { instructionsFor, TOOL_SCHEMAS } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { AGENT_REGISTRY } from '../lib/launch/registry/index.js';
import { agentIdFrom, cliCommandFor, jsonSchemaOf, strictInput, type StrictSpec } from '../lib/mcp/tool-rules.js';

/**
 * LM Test List (shared MCP tool rules):
 * - agentIdFrom maps clientInfo.name onto the launcher registry's closed list, else 'unknown'; two examples each way; the raw name is never returned.
 * - strictInput refuses an unknown property (neither its name nor its value is echoed) and enforces type, enum and length limits.
 * - No registered tool has a property that looks like a token, key, secret, password or credential (positive control: a fixture that does).
 * - The local instructions stay inside the byte budget; the tool that records judgements says in its own description when to offer it.
 */
const SPEC: StrictSpec = {
  tool: 'align_demo',
  required: ['id'],
  properties: {
    id: { type: 'string', description: 'id', maxLength: 5 },
    mode: { type: 'string', description: 'mode', enum: ['a', 'b'] },
    paths: { type: 'array', description: 'paths', maxItems: 2, itemMaxLength: 3 },
  },
};

describe('agentIdFrom', () => {
  it('maps every registry id to itself (all of them, so the list cannot drift from the launcher)', () => {
    for (const a of AGENT_REGISTRY) expect(agentIdFrom({ name: a.name })).toBe(a.name);
    expect(AGENT_REGISTRY.length).toBeGreaterThanOrEqual(17);
  });
  it('maps the known client spellings and ignores case and padding', () => {
    expect(agentIdFrom({ name: 'codex-mcp-client' })).toBe('codex');
    expect(agentIdFrom({ name: 'cursor-vscode' })).toBe('cursor');
    expect(agentIdFrom({ name: '  Claude-Code ' })).toBe('claude-code');
  });
  it('anything else is unknown, and the raw name never comes back (two names, and every non-string)', () => {
    expect(agentIdFrom({ name: 'my-agent 9.9' })).toBe('unknown');
    expect(agentIdFrom({ name: 'claude-code-evil' })).toBe('unknown');
    for (const v of [undefined, null, 7, {}, '', '   ']) expect(agentIdFrom({ name: v })).toBe('unknown');
    expect(agentIdFrom(undefined)).toBe('unknown');
  });
  it('object prototype names are unknown (a table lookup must not inherit)', () => {
    for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(agentIdFrom({ name: n })).toBe('unknown');
  });
});

describe('strictInput', () => {
  it('accepts a valid call and returns it', () => {
    expect(strictInput(SPEC, { id: 'x', mode: 'a', paths: ['a', 'b'] })).toEqual({ id: 'x', mode: 'a', paths: ['a', 'b'] });
  });
  it('refuses an unknown property without printing its name or its value (two examples; a token pasted AS the name is not echoed either)', () => {
    for (const [key, secret] of [['ghp_PASTEDASANAME0123456789', 'ghp_SECRETVALUE'], ['api_key_that_is_far_too_long_to_print', 'sk-SECRETVALUE']] as const) {
      let message = '';
      try { strictInput(SPEC, { id: 'x', [key]: secret }); } catch (e) { message = (e as Error).message; }
      expect(message).toContain('an unknown property (the name is not printed back)');
      expect(message).not.toContain('SECRETVALUE');
      expect(message).not.toContain(key);
      expect(message).not.toContain(key.slice(0, 8));
    }
  });
  it('requires required properties, including when they are empty', () => {
    expect(() => strictInput(SPEC, {})).toThrow(/requires "id"/);
    expect(() => strictInput(SPEC, { id: '' })).toThrow(/requires "id"/);
  });
  it('enforces enum, length and list limits on both sides of each boundary', () => {
    expect(() => strictInput(SPEC, { id: 'x', mode: 'c' })).toThrow(/one of: a, b/);
    expect(() => strictInput(SPEC, { id: 'abcde' })).not.toThrow();
    expect(() => strictInput(SPEC, { id: 'abcdef' })).toThrow(/at most 5/);
    expect(() => strictInput(SPEC, { id: 'x', paths: ['a', 'b'] })).not.toThrow();
    expect(() => strictInput(SPEC, { id: 'x', paths: ['a', 'b', 'c'] })).toThrow(/at most 2 entries/);
    expect(() => strictInput(SPEC, { id: 'x', paths: ['abc'] })).not.toThrow();
    expect(() => strictInput(SPEC, { id: 'x', paths: ['abcd'] })).toThrow(/at most 3 characters/);
    expect(() => strictInput(SPEC, { id: 'x', paths: [1] })).toThrow(/list of strings/);
    expect(() => strictInput(SPEC, { id: 7 })).toThrow(/must be a string/);
  });
  it('advertises the same limits it enforces, and is closed', () => {
    const schema = jsonSchemaOf(SPEC) as { additionalProperties: boolean; required: string[]; properties: Record<string, Record<string, unknown>> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['id']);
    expect(schema.properties['id']).toMatchObject({ maxLength: 5 });
    expect(schema.properties['paths']).toMatchObject({ maxItems: 2, items: { maxLength: 3 } });
    expect(schema.properties['mode']).toMatchObject({ enum: ['a', 'b'] });
  });
});

describe('cliCommandFor', () => {
  it('gives the exact command for the acts that are the person\'s', () => {
    expect(cliCommandFor('ratify', 'd1')).toBe('align ratify d1');
    expect(cliCommandFor('connect', 'github')).toBe('align connect github');
  });
});

const SECRETISH = /token|key|secret|password|credential/i;
function secretProps(schemas: ReadonlyArray<{ name: string; inputSchema: unknown }>): string[] {
  const hits: string[] = [];
  const walk = (tool: string, node: unknown, trail: string): void => {
    if (!node || typeof node !== 'object') return;
    const props = (node as { properties?: Record<string, unknown> }).properties;
    for (const [name, child] of Object.entries(props ?? {})) {
      if (SECRETISH.test(name)) hits.push(`${tool}.${trail}${name}`);
      walk(tool, child, `${trail}${name}.`);
    }
    walk(tool, (node as { items?: unknown }).items, trail);
  };
  for (const t of schemas) walk(t.name, t.inputSchema, '');
  return hits;
}

describe('no registered tool can take a secret', () => {
  it('flags a fixture schema that does (positive control)', () => {
    expect(secretProps([{ name: 'bad', inputSchema: { properties: { apiKey: { type: 'string' } } } }])).toEqual(['bad.apiKey']);
    expect(secretProps([{ name: 'bad', inputSchema: { properties: { nested: { properties: { password: {} } } } } }])).toEqual(['bad.nested.password']);
  });
  it('finds nothing on any tool this server registers, and the control reads a non-empty list', () => {
    expect(TOOL_SCHEMAS.length).toBeGreaterThan(10);
    expect(secretProps(TOOL_SCHEMAS)).toEqual([]);
  });
});

describe('instructions budget and where the mark guidance lives', () => {
  const local = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null } as EnvironmentConfig;
  it('the local instructions stay under Claude Code\'s 2,048-byte cut (bytes, not characters)', () => {
    expect(Buffer.byteLength(instructionsFor(local), 'utf8')).toBeLessThan(2048);
  });
  it('the mark tool carries its own "when to offer" text, because the instructions have no room for it', () => {
    const mark = TOOL_SCHEMAS.find((t) => t.name === 'align_mark')!;
    expect(mark.description).toMatch(/After a conflict/);
    expect(mark.description).toContain('Was that a real conflict?');
    expect(Buffer.byteLength(mark.description, 'utf8')).toBeLessThan(2048);
  });
});
