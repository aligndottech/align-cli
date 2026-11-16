import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { alignClaudeHooks, EDIT_HOOK_MATCHER, HOOK_TIMEOUT_SECONDS, PLUGIN_PACKAGE_SPEC } from '../lib/agent-rules.js';
import { alignServerEntry } from '../lib/mcp-setup.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => JSON.parse(readFileSync(root + rel, 'utf8')) as Record<string, any>;
const NPX = `npx -y ${PLUGIN_PACKAGE_SPEC}`;

describe('Claude Code plugin manifests', () => {
  it('plugin.json carries the documented fields', () => {
    const m = read('.claude-plugin/plugin.json');
    expect(m['name']).toBe('align');
    expect(m['name']).toMatch(/^[a-z0-9-]+$/);
    expect(typeof m['version']).toBe('string');
    expect(typeof m['description']).toBe('string');
    expect(m['author'].name).toBeTruthy();
  });

  it('marketplace.json has name, owner and a plugin entry whose name matches plugin.json', () => {
    const mk = read('.claude-plugin/marketplace.json');
    expect(mk['name']).toBe('aligndottech');
    expect(mk['owner'].name).toBeTruthy();
    expect(mk['plugins']).toHaveLength(1);
    expect(mk['plugins'][0].name).toBe(read('.claude-plugin/plugin.json')['name']);
    expect(mk['plugins'][0].source).toBe('./');
  });

  it('plugin version tracks package.json', () => {
    expect(read('.claude-plugin/plugin.json')['version']).toBe(read('package.json')['version']);
  });
});

describe('plugin hooks match what `align setup` writes', () => {
  const plugin = read('hooks/hooks.json')['hooks'] as Record<string, any[]>;
  const setup = alignClaudeHooks() as Record<string, any[]>;

  for (const event of ['PreToolUse', 'PostToolUse']) {
    it(`${event}: same matcher, timeout and command (npx-run)`, () => {
      expect(plugin[event]).toHaveLength(1);
      const [p] = plugin[event]!;
      const [s] = setup[event]!;
      expect(p.matcher).toBe(EDIT_HOOK_MATCHER);
      expect(p.matcher).toBe(s.matcher);
      expect(p.hooks).toHaveLength(1);
      expect(p.hooks[0].type).toBe('command');
      expect(p.hooks[0].timeout).toBe(HOOK_TIMEOUT_SECONDS);
      expect(p.hooks[0].command).toBe(s.hooks[0].command.replace(/^align /, `${NPX} `));
    });
  }

  it('declares no other hook events (no self-trusting or session hooks)', () => {
    expect(Object.keys(plugin).sort()).toEqual(['PostToolUse', 'PreToolUse']);
  });
});

describe('release-please keeps the plugin version in step', () => {
  it('lists the plugin manifest version as an extra file', () => {
    const extra = read('release-please-config.json')['packages']['.']['extra-files'] as Array<{ path: string; jsonpath: string }>;
    expect(extra.some((e) => e.path === '.claude-plugin/plugin.json' && e.jsonpath === '$.version')).toBe(true);
  });
});

describe('plugin MCP server', () => {
  it('runs the same `mcp` args as the committed .mcp.json entry, through npx', () => {
    const entry = alignServerEntry('mcpServers', undefined, { committed: true }) as { args: string[] };
    const decl = read('.claude-plugin/plugin.json')['mcpServers'].align;
    expect(decl.command).toBe('npx');
    expect(decl.args).toEqual(['-y', PLUGIN_PACKAGE_SPEC, ...entry.args]);
  });
});
