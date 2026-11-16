import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { alignClaudeHooks, EDIT_HOOK_MATCHER, HOOK_TIMEOUT_SECONDS } from '../lib/agent-rules.js';
import { alignServerEntry } from '../lib/mcp-setup.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => JSON.parse(readFileSync(root + rel, 'utf8')) as Record<string, any>;
const PLUGIN_DIR = 'plugins/align';
const PLUGIN_JSON = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
const HOOKS_JSON = `${PLUGIN_DIR}/hooks/hooks.json`;
const PIN = `@aligndottech/cli@${read('package.json')['version']}`;

function listFiles(dir: string): string[] {
  return readdirSync(root + dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
}

describe('Claude Code plugin manifests', () => {
  it('plugin.json carries the documented fields', () => {
    const m = read(PLUGIN_JSON);
    expect(m['name']).toBe('align');
    expect(m['name']).toMatch(/^[a-z0-9-]+$/);
    expect(typeof m['version']).toBe('string');
    expect(typeof m['description']).toBe('string');
    expect(m['author'].name).toBeTruthy();
  });

  it('marketplace.json has name, owner and a plugin entry that points at the plugin folder', () => {
    const mk = read('.claude-plugin/marketplace.json');
    expect(mk['name']).toBe('aligndottech');
    expect(mk['owner'].name).toBeTruthy();
    expect(mk['plugins']).toHaveLength(1);
    expect(mk['plugins'][0].name).toBe(read(PLUGIN_JSON)['name']);
    expect(mk['plugins'][0].source).toBe(`./${PLUGIN_DIR}`);
    expect(existsSync(root + PLUGIN_JSON)).toBe(true);
  });

  it('the repo root no longer carries a plugin manifest or hooks file the validator would scan', () => {
    expect(existsSync(`${root}.claude-plugin/plugin.json`)).toBe(false);
    expect(existsSync(`${root}hooks/hooks.json`)).toBe(false);
  });
});

describe('plugin folder holds only what the plugin directory accepts', () => {
  it('is exactly plugin.json, icon.png and hooks.json (no package.json, lockfile or scripts)', () => {
    const files = listFiles(PLUGIN_DIR).sort();
    expect(files).toEqual([
      `${PLUGIN_DIR}/.claude-plugin/icon.png`,
      `${PLUGIN_DIR}/.claude-plugin/plugin.json`,
      `${PLUGIN_DIR}/hooks/hooks.json`,
    ]);
  });

  it('the icon is a square PNG, 512 to 2048 px, under 2 MB', () => {
    const f = `${root}${PLUGIN_DIR}/.claude-plugin/icon.png`;
    const b = readFileSync(f);
    expect(b.subarray(1, 4).toString()).toBe('PNG');
    const w = b.readUInt32BE(16);
    const h = b.readUInt32BE(20);
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(512);
    expect(w).toBeLessThanOrEqual(2048);
    expect(statSync(f).size).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('every npx in the plugin is `npx` plus exact-version args', () => {
  const hooks = read(HOOKS_JSON)['hooks'] as Record<string, any[]>;
  const entries: Array<{ where: string; command: string; args: string[] }> = [
    ...Object.entries(read(PLUGIN_JSON)['mcpServers']).map(([k, v]: [string, any]) => ({ where: `mcp:${k}`, command: v.command, args: v.args })),
    ...Object.entries(hooks).flatMap(([ev, groups]) =>
      groups.flatMap((g) => g.hooks.map((h: any) => ({ where: ev, command: h.command, args: h.args }))),
    ),
  ];

  it('found the entries (positive control: 1 server, 2 hooks)', () => {
    expect(entries).toHaveLength(3);
  });

  for (const e of entries) {
    it(`${e.where}: command is exactly npx, args are plain words, the package is pinned X.Y.Z`, () => {
      expect(e.command).toBe('npx');
      expect(Array.isArray(e.args)).toBe(true);
      for (const a of e.args) expect(a).toMatch(/^[@A-Za-z0-9._/-]+$/);
      const pkgs = e.args.filter((a) => a.startsWith('@aligndottech/cli@'));
      expect(pkgs).toHaveLength(1);
      expect(pkgs[0]).toMatch(/^@aligndottech\/cli@\d+\.\d+\.\d+$/);
    });
  }
});

describe('the pin follows package.json', () => {
  it('plugin.json version, MCP pin and both hook pins equal the package.json version', () => {
    const v = read('package.json')['version'];
    expect(read(PLUGIN_JSON)['version']).toBe(v);
    expect(read(PLUGIN_JSON)['mcpServers'].align.args).toContain(PIN);
    const hooks = read(HOOKS_JSON)['hooks'] as Record<string, any[]>;
    for (const ev of ['PreToolUse', 'PostToolUse']) expect(hooks[ev]![0].hooks[0].args).toContain(PIN);
  });

  it('release-please keeps plugin.json version in step, and the pins are covered by sync-plugin-version', () => {
    const extra = read('release-please-config.json')['packages']['.']['extra-files'] as Array<{ path: string; jsonpath: string }>;
    expect(extra.some((e) => e.path === PLUGIN_JSON && e.jsonpath === '$.version')).toBe(true);
    expect(read('package.json')['scripts']['sync-plugin-version']).toContain('sync-plugin-version.mjs');
  });
});

describe('plugin hooks match what `align setup` writes', () => {
  const plugin = read(HOOKS_JSON)['hooks'] as Record<string, any[]>;
  const setup = alignClaudeHooks() as Record<string, any[]>;

  for (const event of ['PreToolUse', 'PostToolUse']) {
    it(`${event}: same matcher, timeout and command (npx exec form)`, () => {
      expect(plugin[event]).toHaveLength(1);
      const [p] = plugin[event]!;
      const [s] = setup[event]!;
      expect(p.matcher).toBe(EDIT_HOOK_MATCHER);
      expect(p.matcher).toBe(s.matcher);
      expect(p.hooks).toHaveLength(1);
      expect(p.hooks[0].type).toBe('command');
      expect(p.hooks[0].timeout).toBe(HOOK_TIMEOUT_SECONDS);
      const [bin, ...rest] = (s.hooks[0].command as string).split(' ');
      expect(bin).toBe('align');
      expect(p.hooks[0].command).toBe('npx');
      expect(p.hooks[0].args).toEqual(['-y', PIN, ...rest]);
    });
  }

  it('declares no other hook events (no self-trusting or session hooks)', () => {
    expect(Object.keys(plugin).sort()).toEqual(['PostToolUse', 'PreToolUse']);
  });
});

describe('plugin MCP server', () => {
  it('runs the same `mcp` args as the committed .mcp.json entry, through npx', () => {
    const entry = alignServerEntry('mcpServers', undefined, { committed: true }) as { args: string[] };
    const decl = read(PLUGIN_JSON)['mcpServers'].align;
    expect(decl.command).toBe('npx');
    expect(decl.args).toEqual(['-y', PIN, ...entry.args]);
  });
});
