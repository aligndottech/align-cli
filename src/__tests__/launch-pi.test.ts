import { describe, expect, it } from 'vitest';
import { alignNudgeBody, piExtensionBody } from '../lib/agent-rules.js';
import { buildPiLaunch, type PiLaunchContext } from '../lib/launch/adapters/pi.js';

/*
 * C4 Test List (pi adapter, pure builder):
 *  1. nothing in the project: -e extension + --append-system-prompt + an MCP write are all requested
 *  2. each injection is skipped on its own flag, both sides (extension / block / mcp)
 *  3. the extension file is the SAME text the project writer produces, aimed at the local graph
 *  4. the MCP entry is named align-local, never align, and goes to the agent dir file
 *  5. pass-through args first, injected flags last; a literal `--` keeps our flags before it
 *  6. ALIGN_WRAPPED carried; PI_CODING_AGENT_DIR is never set (it holds auth and history)
 */
const BASE: PiLaunchContext = {
  passthrough: [],
  projectHasExtension: false,
  projectHasMcp: false,
  projectHasBlock: false,
  mcpFile: '/home/u/.pi/agent/mcp.json',
  cachePath: (n) => `/cache/${n}`,
};
const ctx = (over: Partial<PiLaunchContext> = {}): PiLaunchContext => ({ ...BASE, ...over });

describe('buildPiLaunch', () => {
  it('requests the extension, the instructions and one MCP write when the project carries none', () => {
    const spec = buildPiLaunch(ctx());
    expect(spec.bin).toBe('pi');
    expect(spec.args).toEqual(['-e', '/cache/pi-align.ts', '--append-system-prompt', '/cache/align-instructions.md']);
    expect(spec.files.map((f) => f.name).sort()).toEqual(['align-instructions.md', 'pi-align.ts']);
    expect(spec.writes).toHaveLength(1);
  });

  it('the extension is the project writer\'s own text for the local graph, and the instructions are the managed block body', () => {
    const spec = buildPiLaunch(ctx());
    expect(spec.files.find((f) => f.name === 'pi-align.ts')!.content).toBe(piExtensionBody('local'));
    expect(piExtensionBody('local')).toContain('"--env", "local"');
    expect(spec.files.find((f) => f.name === 'align-instructions.md')!.content).toBe(`${alignNudgeBody()}\n`);
  });

  it('the MCP write is align-local (never align) in the agent-dir file, with directTools', () => {
    const w = buildPiLaunch(ctx()).writes![0]!;
    expect(w).toMatchObject({ kind: 'mcp-entry', file: '/home/u/.pi/agent/mcp.json', topKey: 'mcpServers', name: 'align-local' });
    expect((w as { entry: Record<string, unknown> }).entry).toMatchObject({ command: 'align', args: ['mcp', '--env', 'local'], directTools: true });
  });

  it.each([
    ['projectHasExtension', ['-e']],
    ['projectHasBlock', ['--append-system-prompt']],
  ] as const)('%s drops only its own flag', (flag, dropped) => {
    const spec = buildPiLaunch(ctx({ [flag]: true }));
    for (const d of dropped) expect(spec.args).not.toContain(d);
    expect(spec.args.length).toBe(2);
  });

  it('projectHasMcp drops only the write; the flags stay', () => {
    const spec = buildPiLaunch(ctx({ projectHasMcp: true }));
    expect(spec.writes).toBeUndefined();
    expect(spec.args).toContain('-e');
  });

  it('with everything present it injects nothing but the recursion guard', () => {
    const spec = buildPiLaunch(ctx({ projectHasExtension: true, projectHasMcp: true, projectHasBlock: true }));
    expect(spec).toEqual({ bin: 'pi', args: [], env: { ALIGN_WRAPPED: '1' }, files: [] });
  });

  it('puts the user\'s args first and ours last (two prompts)', () => {
    expect(buildPiLaunch(ctx({ passthrough: ['fix the bug'] })).args.slice(0, 2)).toEqual(['fix the bug', '-e']);
    expect(buildPiLaunch(ctx({ passthrough: ['-p', 'hi', '--model', 'x'] })).args.slice(0, 4)).toEqual(['-p', 'hi', '--model', 'x']);
  });

  it('keeps our flags before a literal -- so they are not read as messages', () => {
    const args = buildPiLaunch(ctx({ passthrough: ['--', '@notes.md'] })).args;
    expect(args.indexOf('-e')).toBeLessThan(args.indexOf('--'));
    expect(args.slice(args.indexOf('--'))).toEqual(['--', '@notes.md']);
  });

  it('sets ALIGN_WRAPPED and never PI_CODING_AGENT_DIR', () => {
    expect(buildPiLaunch(ctx()).env).toEqual({ ALIGN_WRAPPED: '1' });
  });
});
