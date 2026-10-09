import { afterAll, describe, expect, it } from 'vitest';
import { openCodePluginBody } from '../lib/agent-rules.js';
import { buildOpenCodeLaunch, type OpenCodeLaunchContext } from '../lib/launch/adapters/opencode.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * C2 Test List (OpenCode adapter, pure builder):
 *  1. nothing in the project: MCP (align-local) + plugin dir + instructions are all injected
 *  2. each injection is skipped on its own flag, both sides (plugin / mcp / block)
 *  3. the injected server is never named `align` (a user's own server must survive)
 *  4. the user's own OPENCODE_CONFIG_CONTENT is merged, never replaced; invalid JSON is left alone
 *  5. the user's own OPENCODE_CONFIG_DIR is never overridden (one dir only)
 *  6. pass-through args first, ALIGN_WRAPPED carried, no secret-bearing field
 *  7. win32 goes through cmd /c
 */
const BASE: OpenCodeLaunchContext = {
  passthrough: [],
  env: {},
  projectHasPlugin: false,
  projectHasMcp: false,
  projectHasBlock: false,
  cachePath: (name) => `/cache/${name}`,
};
const ctx = (over: Partial<OpenCodeLaunchContext> = {}): OpenCodeLaunchContext => ({ ...BASE, ...over });
const content = (spec: ReturnType<typeof buildOpenCodeLaunch>) => JSON.parse(spec.env['OPENCODE_CONFIG_CONTENT'] ?? 'null');

describe('buildOpenCodeLaunch: injection', () => {
  it('injects the MCP server, the plugin dir and the instructions when the project carries none', () => {
    const spec = buildOpenCodeLaunch(ctx());
    expect(spec.bin).toBe('opencode');
    expect(spec.env['ALIGN_WRAPPED']).toBe('1');
    expect(content(spec).mcp['align-local']).toEqual({ type: 'local', command: ['align', 'mcp', '--env', 'local'] });
    expect(content(spec).instructions).toEqual(['/cache/align-instructions.md']);
    expect(spec.env['OPENCODE_CONFIG_DIR']).toBe('/cache/opencode-config');
    expect(spec.files.map((f) => f.name).sort()).toEqual(['align-instructions.md', 'opencode-config/plugins/align.js']);
  });

  it('the plugin file is the SAME text the project writer produces, aimed at the local graph', () => {
    const f = buildOpenCodeLaunch(ctx()).files.find((x) => x.name === 'opencode-config/plugins/align.js')!;
    expect(f.content).toBe(openCodePluginBody('local'));
    expect(f.content).toContain('"--env", "local"');
  });

  it('the server is named align-local, never align, so a user\'s own align server survives', () => {
    expect(Object.keys(content(buildOpenCodeLaunch(ctx())).mcp)).toEqual(['align-local']);
  });

  it('with everything already present it injects nothing but the recursion guard', () => {
    const spec = buildOpenCodeLaunch(ctx({ projectHasPlugin: true, projectHasMcp: true, projectHasBlock: true }));
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.files).toEqual([]);
  });

  it('projectHasMcp drops only the mcp key', () => {
    const spec = buildOpenCodeLaunch(ctx({ projectHasMcp: true }));
    expect(content(spec).mcp).toBeUndefined();
    expect(content(spec).instructions).toBeDefined();
    expect(spec.env['OPENCODE_CONFIG_DIR']).toBeDefined();
  });

  it('projectHasBlock drops only the instructions (key and file)', () => {
    const spec = buildOpenCodeLaunch(ctx({ projectHasBlock: true }));
    expect(content(spec).instructions).toBeUndefined();
    expect(content(spec).mcp['align-local']).toBeDefined();
    expect(spec.files.map((f) => f.name)).toEqual(['opencode-config/plugins/align.js']);
  });

  it('projectHasPlugin drops only the plugin dir and its file', () => {
    const spec = buildOpenCodeLaunch(ctx({ projectHasPlugin: true }));
    expect(spec.env['OPENCODE_CONFIG_DIR']).toBeUndefined();
    expect(spec.files.map((f) => f.name)).toEqual(['align-instructions.md']);
    expect(content(spec).mcp['align-local']).toBeDefined();
  });

  it('holds no secret-bearing field', () => {
    expect(JSON.stringify(buildOpenCodeLaunch(ctx()).env)).not.toMatch(/token|secret|api[_-]?key/i);
  });
});

describe('buildOpenCodeLaunch: the user\'s own config survives', () => {
  it('merges into an OPENCODE_CONFIG_CONTENT the user already set, keeping their keys', () => {
    const theirs = JSON.stringify({ model: 'x/y', mcp: { mine: { type: 'remote', url: 'https://e.test' } }, instructions: ['/their.md'] });
    const c = content(buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_CONTENT: theirs } })));
    expect(c.model).toBe('x/y');
    expect(c.mcp.mine).toEqual({ type: 'remote', url: 'https://e.test' });
    expect(c.mcp['align-local']).toBeDefined();
    expect(c.instructions).toEqual(['/their.md', '/cache/align-instructions.md']);
  });

  it('a user server named align is not touched', () => {
    const theirs = JSON.stringify({ mcp: { align: { type: 'remote', url: 'https://prod.test' } } });
    const c = content(buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_CONTENT: theirs } })));
    expect(c.mcp.align).toEqual({ type: 'remote', url: 'https://prod.test' });
  });

  it('leaves an unparseable OPENCODE_CONFIG_CONTENT exactly as the user set it (OpenCode reports it)', () => {
    const spec = buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_CONTENT: '{not json' } }));
    expect(spec.env['OPENCODE_CONFIG_CONTENT']).toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a non-object', '[1]'],
    ['mcp of the wrong type', '{"mcp":[]}'],
    ['instructions of the wrong type', '{"instructions":"x.md"}'],
  ])('says why the graph tools were not added when OPENCODE_CONFIG_CONTENT is unusable (%s)', (_l, raw) => {
    const spec = buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_CONTENT: raw } }));
    expect(spec.notes).toHaveLength(1);
    expect(spec.notes![0]).toMatch(/OPENCODE_CONFIG_CONTENT/);
    expect(spec.notes![0]).toMatch(/graph tools were not added/);
  });
  it('says nothing when the user content is usable, or when nothing needed adding', () => {
    expect(buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_CONTENT: '{"model":"a/b"}' } })).notes ?? []).toEqual([]);
    const all = { projectHasPlugin: true, projectHasMcp: true, projectHasBlock: true };
    expect(buildOpenCodeLaunch(ctx({ ...all, env: { OPENCODE_CONFIG_CONTENT: '{not json' } })).notes ?? []).toEqual([]);
  });
  it('an empty OPENCODE_CONFIG_CONTENT counts as unset', () => {
    expect(content(buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_CONTENT: '' } }))).mcp['align-local']).toBeDefined();
  });

  it('does not override a OPENCODE_CONFIG_DIR the user set, and skips the plugin file', () => {
    const spec = buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_DIR: '/their/dir' } }));
    expect(spec.env['OPENCODE_CONFIG_DIR']).toBeUndefined();
    expect(spec.files.map((f) => f.name)).toEqual(['align-instructions.md']);
  });

  it('an empty OPENCODE_CONFIG_DIR counts as unset', () => {
    expect(buildOpenCodeLaunch(ctx({ env: { OPENCODE_CONFIG_DIR: '' } })).env['OPENCODE_CONFIG_DIR']).toBe('/cache/opencode-config');
  });
});

describe('buildOpenCodeLaunch: args and platform', () => {
  it('passes the user\'s args through, unchanged and alone (all injection is env)', () => {
    expect(buildOpenCodeLaunch(ctx({ passthrough: ['run', 'hello'] })).args).toEqual(['run', 'hello']);
    expect(buildOpenCodeLaunch(ctx({ passthrough: ['--continue'] })).args).toEqual(['--continue']);
  });

  afterAll(restorePlatform);
  it('on win32 the server goes through cmd /c, the form the other writers use', () => {
    setPlatform('win32');
    expect(content(buildOpenCodeLaunch(ctx())).mcp['align-local'].command).toEqual(['cmd', '/c', 'align', 'mcp', '--env', 'local']);
  });
  it('on linux it is the bare align command', () => {
    setPlatform('linux');
    expect(content(buildOpenCodeLaunch(ctx())).mcp['align-local'].command[0]).toBe('align');
  });
});
