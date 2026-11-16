import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLUGIN_PACKAGE_SPEC } from '../lib/agent-rules.js';
import { advisoryHookCommand, codexHookEntry } from '../lib/user-hooks.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => JSON.parse(readFileSync(root + rel, 'utf8')) as Record<string, any>;

describe('Codex plugin overlay', () => {
  const manifest = read('.codex-plugin/plugin.json');

  it('has the same name and version as the Claude Code plugin and package.json', () => {
    expect(manifest['name']).toBe(read('.claude-plugin/plugin.json')['name']);
    expect(manifest['version']).toBe(read('package.json')['version']);
  });

  it('declares the same MCP server as the Claude Code plugin', () => {
    expect(manifest['mcpServers']).toEqual(read('.claude-plugin/plugin.json')['mcpServers']);
  });

  it('points at a hooks file that exists', () => {
    expect(manifest['hooks']).toBe('./hooks/codex-hooks.json');
    expect(() => read('hooks/codex-hooks.json')).not.toThrow();
  });

  it('release-please keeps its version in step', () => {
    const extra = read('release-please-config.json')['packages']['.']['extra-files'] as Array<{ path: string; jsonpath: string }>;
    expect(extra.some((e) => e.path === '.codex-plugin/plugin.json' && e.jsonpath === '$.version')).toBe(true);
  });
});

describe('Codex plugin hooks match what `align setup` writes for Codex', () => {
  const hooks = read('hooks/codex-hooks.json')['hooks'] as Record<string, any[]>;

  it('PreToolUse only, with setup\'s matcher, timeout and command (npx-run)', () => {
    expect(Object.keys(hooks)).toEqual(['PreToolUse']);
    const setup = codexHookEntry(advisoryHookCommand('codex')) as { hooks: Array<{ command: string }> };
    const expected = { ...setup, hooks: [{ ...setup.hooks[0], command: setup.hooks[0]!.command.replace(/^align /, `npx -y ${PLUGIN_PACKAGE_SPEC} `) }] };
    expect(hooks['PreToolUse']).toEqual([expected]);
  });

  it('the matcher names apply_patch, the tool Codex edits files with', () => {
    expect(new RegExp(`^(?:${hooks['PreToolUse']![0].matcher})$`).test('apply_patch')).toBe(true);
  });
});
