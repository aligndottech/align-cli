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
// The pinned version is the last PROMOTED release, which can trail package.json while a release is
// staged on `next`: pinning ahead would hand plugin users a version that has not passed E2E.
const PIN = (read(PLUGIN_JSON)['mcpServers'].align.args as string[]).find((a) => a.startsWith('@aligndottech/cli@'))!;
const semver = (v: string) => v.split('.').map(Number);
const atMost = (a: string, b: string) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!; return true; };

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

describe('every npx in the plugin pins an exact version', () => {
  it('the MCP server is `npx` plus plain-word args with one exact pin', () => {
    const v = read(PLUGIN_JSON)['mcpServers'].align as { command: string; args: string[] };
    expect(v.command).toBe('npx');
    for (const a of v.args) expect(a).toMatch(/^[@A-Za-z0-9._/-]+$/);
    expect(v.args.filter((a) => /^@aligndottech\/cli@\d+\.\d+\.\d+$/.test(a))).toHaveLength(1);
  });

  // Shell form, not `command` plus `args`: exec form starts the program directly, and on Windows npx is
  // npx.cmd, which exec form cannot start, so the hooks would never run there.
  for (const ev of ['PreToolUse', 'PostToolUse']) {
    it(`${ev}: one shell-form command with an exact pin and no args`, () => {
      const hk = (read(HOOKS_JSON)['hooks'] as Record<string, any[]>)[ev]![0].hooks[0];
      expect(hk.args).toBeUndefined();
      expect(hk.command).toMatch(/^npx -y @aligndottech\/cli@\d+\.\d+\.\d+ check --advisory$/);
    });
  }
});

describe('the pin', () => {
  it('is the same version in the MCP server and both hooks', () => {
    const hooks = read(HOOKS_JSON)['hooks'] as Record<string, any[]>;
    for (const ev of ['PreToolUse', 'PostToolUse']) expect(hooks[ev]![0].hooks[0].command).toContain(` ${PIN} `);
  });

  it('never runs ahead of package.json (it moves only after a release is promoted)', () => {
    expect(atMost(PIN.split('@').pop()!, read('package.json')['version'])).toBe(true);
  });

  it('release-please keeps plugin.json version in step, and sync-plugin-version exists for the pins', () => {
    const extra = read('release-please-config.json')['packages']['.']['extra-files'] as Array<{ path: string; jsonpath: string }>;
    expect(extra.some((e) => e.path === PLUGIN_JSON && e.jsonpath === '$.version')).toBe(true);
    expect(read('package.json')['scripts']['sync-plugin-version']).toContain('sync-plugin-version.mjs');
  });
});

describe('sync-plugin-version', () => {
  it('rewrites only the version inside the shell-form hook, keeping the rest of the command', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, cpSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(`${tmpdir()}/align-sync-`);
    mkdirSync(`${dir}/scripts`);
    cpSync(`${root}scripts/sync-plugin-version.mjs`, `${dir}/scripts/sync-plugin-version.mjs`);
    cpSync(`${root}${PLUGIN_DIR}`, `${dir}/${PLUGIN_DIR}`, { recursive: true });
    // package.json names a newer release that is merged but still staged on `next`;
    // the pin must follow the promoted `latest` (9.9.9), never package.json (9.9.10).
    writeFileSync(`${dir}/package.json`, JSON.stringify({ version: '9.9.10' }));
    execFileSync(process.execPath, [`${dir}/scripts/sync-plugin-version.mjs`], {
      env: { ...process.env, ALIGN_SYNC_LATEST: '9.9.9' },
    });
    const hooks = JSON.parse(readFileSync(`${dir}/${HOOKS_JSON}`, 'utf8'))['hooks'] as Record<string, any[]>;
    for (const ev of ['PreToolUse', 'PostToolUse']) expect(hooks[ev]![0].hooks[0].command).toBe('npx -y @aligndottech/cli@9.9.9 check --advisory');
    const mcp = JSON.parse(readFileSync(`${dir}/${PLUGIN_JSON}`, 'utf8'))['mcpServers'].align.args;
    expect(mcp).toEqual(['-y', '@aligndottech/cli@9.9.9', 'mcp']);
  });
});

describe('plugin hooks match what `align setup` writes', () => {
  const plugin = read(HOOKS_JSON)['hooks'] as Record<string, any[]>;
  const setup = alignClaudeHooks() as Record<string, any[]>;

  for (const event of ['PreToolUse', 'PostToolUse']) {
    it(`${event}: same matcher, timeout and command (through npx, pinned)`, () => {
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
      expect(p.hooks[0].command).toBe(`npx -y ${PIN} ${rest.join(' ')}`);
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
