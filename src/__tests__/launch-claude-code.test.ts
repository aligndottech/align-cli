import { describe, expect, it } from 'vitest';
import { buildClaudeLaunch, type LaunchContext } from '../lib/launch/adapters/claude-code.js';

const BASE: LaunchContext = {
  passthrough: [],
  projectHasHooks: false,
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
    const spec = buildClaudeLaunch(ctx({ projectHasHooks: true, projectHasMcp: true, projectHasBlock: true }));
    expect(spec.args).toEqual([]);
    expect(spec.files).toEqual([]);
  });

  it.each([
    ['projectHasHooks', '--settings'],
    ['projectHasMcp', '--mcp-config'],
    ['projectHasBlock', '--append-system-prompt-file'],
  ] as const)('%s drops only %s', (key, flag) => {
    const args = buildClaudeLaunch(ctx({ [key]: true })).args;
    expect(args).not.toContain(flag);
    expect(args.filter((a) => a.startsWith('--')).length).toBe(2);
  });

  it('the MCP file points at the local graph and holds no secret-bearing field', () => {
    const json = JSON.parse(fileNamed(buildClaudeLaunch(ctx()), 'claude-mcp.json')!.content);
    expect(json.mcpServers.align.args).toEqual(expect.arrayContaining(['mcp', '--env', 'local']));
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

  it.each([[['--resume', 'abc']], [['-p', 'hi']]])('appends pass-through args %j last', (passthrough) => {
    expect(buildClaudeLaunch(ctx({ passthrough })).args.slice(-passthrough.length)).toEqual(passthrough);
    expect(buildClaudeLaunch(ctx({ passthrough, projectHasHooks: true, projectHasMcp: true, projectHasBlock: true })).args).toEqual(passthrough);
  });
});
