import { describe, expect, it } from 'vitest';
import { buildClaudeLaunch, type LaunchContext } from '../lib/launch/adapters/claude-code.js';

const BASE: LaunchContext = {
  passthrough: [],
  projectHasPreHook: false,
  projectHasPostHook: false,
  projectHasMcp: false,
  projectHasBlock: false,
  cachePath: (name) => `/cache/${name}`,
};
const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({ ...BASE, ...over });
const fileNamed = (spec: ReturnType<typeof buildClaudeLaunch>, name: string) => spec.files.find((f) => f.name === name);

describe('buildClaudeLaunch', () => {
  it('injects MCP, hooks and instructions when the project carries none', () => {
    const spec = buildClaudeLaunch(ctx());
    expect(spec.bin).toBe('claude');
    expect(spec.args).toEqual(
      expect.arrayContaining(['--mcp-config', '/cache/claude-mcp.json', '--settings', '/cache/claude-settings.json', '--append-system-prompt-file', '/cache/align-instructions.md']),
    );
    expect(spec.args).not.toContain('--strict-mcp-config');
    expect(spec.env.ALIGN_WRAPPED).toBe('1');
  });

  it('skips each injection the project already carries', () => {
    const spec = buildClaudeLaunch(ctx({ projectHasPreHook: true, projectHasPostHook: true, projectHasMcp: true, projectHasBlock: true }));
    expect(spec.args).toEqual([]);
    expect(spec.files).toEqual([]);
  });

  it.each([
    ['projectHasMcp', '--mcp-config'],
    ['projectHasBlock', '--append-system-prompt-file'],
  ] as const)('%s drops only %s', (key, flag) => {
    const args = buildClaudeLaunch(ctx({ [key]: true })).args;
    expect(args).not.toContain(flag);
    expect(args.filter((a) => a.startsWith('--')).length).toBe(2);
  });

  it('with both hook groups present, --settings is dropped; with one missing it is kept', () => {
    expect(buildClaudeLaunch(ctx({ projectHasPreHook: true, projectHasPostHook: true })).args).not.toContain('--settings');
    expect(buildClaudeLaunch(ctx({ projectHasPreHook: true })).args).toContain('--settings');
  });

  it.each([
    ['projectHasPreHook', 'PostToolUse', 'PreToolUse'],
    ['projectHasPostHook', 'PreToolUse', 'PostToolUse'],
  ] as const)('%s: the settings file carries only the missing group (%s, not %s)', (key, carried, omitted) => {
    const spec = buildClaudeLaunch(ctx({ [key]: true }));
    const settingsFile = spec.files.find((f) => f.name.startsWith('claude-settings'))!;
    const hooks = JSON.parse(settingsFile.content).hooks;
    expect(Object.keys(hooks)).toEqual([carried]);
    expect(hooks[omitted]).toBeUndefined();
    expect(spec.args).toContain(`/cache/${settingsFile.name}`);
  });

  it('the three settings variants have three different file names, so cached files never flap', () => {
    const names = [ctx(), ctx({ projectHasPreHook: true }), ctx({ projectHasPostHook: true })]
      .map((c) => buildClaudeLaunch(c).files.find((f) => f.name.startsWith('claude-settings'))!.name);
    expect(new Set(names).size).toBe(3);
  });

  // claude 2.1.291: a --mcp-config server with the SAME NAME as one the user configured
  // replaces it for the session (verified: user `align`=A plus injected `align`=B starts only B).
  it('names the injected server align-local, never align, so a user\'s own align server survives', () => {
    const json = JSON.parse(fileNamed(buildClaudeLaunch(ctx()), 'claude-mcp.json')!.content);
    expect(Object.keys(json.mcpServers)).toEqual(['align-local']);
  });

  it('the MCP file points at the local graph and holds no secret-bearing field', () => {
    const json = JSON.parse(fileNamed(buildClaudeLaunch(ctx()), 'claude-mcp.json')!.content);
    expect(json.mcpServers['align-local'].args).toEqual(expect.arrayContaining(['mcp', '--env', 'local']));
    expect(JSON.stringify(json)).not.toMatch(/token|key|secret/i);
  });

  it('the settings file carries the Pre and PostToolUse advisory hooks', () => {
    const json = JSON.parse(fileNamed(buildClaudeLaunch(ctx()), 'claude-settings.json')!.content);
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(json.hooks[event][0].hooks[0].command).toContain('align check --advisory');
    }
  });

  it('the instructions file is the managed block', () => {
    const text = fileNamed(buildClaudeLaunch(ctx()), 'align-instructions.md')!.content;
    expect(text).toContain('align:start');
    expect(text).toContain('align_check_alignment');
  });

  it.each([[['--resume', 'abc']], [['-p', 'hi']]])('puts pass-through args %j FIRST, before every injected flag', (passthrough) => {
    const args = buildClaudeLaunch(ctx({ passthrough })).args;
    expect(args.slice(0, passthrough.length)).toEqual(passthrough);
    expect(buildClaudeLaunch(ctx({ passthrough, projectHasPreHook: true, projectHasPostHook: true, projectHasMcp: true, projectHasBlock: true })).args).toEqual(passthrough);
  });

  // claude's --mcp-config is variadic: `--mcp-config m.json "a prompt"` reads the prompt as a
  // second config file (verified against claude 2.1.291). Nothing may follow it.
  it('a positional prompt precedes --mcp-config, and --mcp-config is the last flag group', () => {
    const args = buildClaudeLaunch(ctx({ passthrough: ['a prompt'], projectHasPreHook: true, projectHasPostHook: true, projectHasBlock: true })).args;
    expect(args).toEqual(['a prompt', '--mcp-config', '/cache/claude-mcp.json']);
    const all = buildClaudeLaunch(ctx({ passthrough: ['a prompt'] })).args;
    expect(all.indexOf('a prompt')).toBe(0);
    expect(all.slice(-2)).toEqual(['--mcp-config', '/cache/claude-mcp.json']);
  });
});
