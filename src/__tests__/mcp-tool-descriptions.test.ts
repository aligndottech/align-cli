import { describe, expect, it } from 'vitest';

import { toolSchemasFor } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config';

/**
 * A tool description is the only thing an agent reads before choosing a tool, and directory
 * graders (Glama's tool score) grade on it: when to use the tool, what it returns, and which
 * sibling to use instead. align_check_drift and align_get_impact said one line each.
 *
 * Test List:
 * - check_drift says when to use it (one known decision) and routes a whole-graph check to align_check_alignment
 * - check_drift names the fields it returns, score and drifted
 * - get_impact names the two lists it returns, upstream and downstream
 * - both hold in local and cloud mode (toolSchemasFor rewrites some descriptions per mode)
 */

const localEnv = { mode: 'local-embedded', gatewayUrl: '', localDbPath: '/tmp/x.db' } as unknown as EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't' } as unknown as EnvironmentConfig;

function describeTool(env: EnvironmentConfig, name: string): string {
  const tool = toolSchemasFor(env).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.description;
}

describe.each([['local', localEnv], ['cloud', cloudEnv]])('MCP tool descriptions (%s)', (_label, env) => {
  it('align_check_drift says when to use it and routes a whole-graph check elsewhere', () => {
    const d = describeTool(env, 'align_check_drift');
    expect(d).toMatch(/one decision/i);
    expect(d).toContain('align_check_alignment');
  });

  it('align_check_drift names what it returns', () => {
    const d = describeTool(env, 'align_check_drift');
    expect(d).toContain('`score`');
    expect(d).toContain('`drifted`');
  });

  it('align_get_impact names the two lists it returns', () => {
    const d = describeTool(env, 'align_get_impact');
    expect(d).toContain('`upstream`');
    expect(d).toContain('`downstream`');
  });
});
