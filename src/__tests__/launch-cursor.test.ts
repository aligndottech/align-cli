import { describe, expect, it } from 'vitest';
import { buildCursorLaunch, type CursorLaunchContext } from '../lib/launch/adapters/cursor.js';

/*
 * C4 Test List (Cursor adapter, pure builder; cursor-agent is NOT installed on the dev machine):
 *  1. nothing present: an align-local MCP write and a hooks write, and no flags
 *  2. each write is skipped on its own flag, both sides (mcp / hooks)
 *  3. --approve-mcps is never passed (it approves every unapproved server, the user's own included)
 *  4. pass-through args are the whole of the args
 *  5. ALIGN_WRAPPED carried, no launch files
 */
const BASE: CursorLaunchContext = {
  passthrough: [],
  projectHasMcp: false,
  hooksPresent: false,
  mcpFile: '/home/u/.cursor/mcp.json',
  hooksFile: '/home/u/.cursor/hooks.json',
};
const ctx = (over: Partial<CursorLaunchContext> = {}): CursorLaunchContext => ({ ...BASE, ...over });

describe('buildCursorLaunch', () => {
  it('asks for both writes and no flags when nothing is present', () => {
    const spec = buildCursorLaunch(ctx());
    expect(spec.bin).toBe('cursor-agent');
    expect(spec.args).toEqual([]);
    expect(spec.writes).toEqual([
      expect.objectContaining({ kind: 'mcp-entry', file: '/home/u/.cursor/mcp.json', topKey: 'mcpServers', name: 'align-local' }),
      { kind: 'cursor-hooks', file: '/home/u/.cursor/hooks.json' },
    ]);
    expect(spec.files).toEqual([]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
  });

  it('the MCP entry targets the local graph and is never named align', () => {
    const w = buildCursorLaunch(ctx()).writes![0] as { name: string; entry: { args: string[] } };
    expect(w.name).toBe('align-local');
    expect(w.entry.args).toEqual(['mcp', '--env', 'local']);
  });

  it('hooksPresent drops only the hooks write; projectHasMcp drops only the MCP write', () => {
    expect(buildCursorLaunch(ctx({ hooksPresent: true })).writes!.map((w) => w.kind)).toEqual(['mcp-entry']);
    expect(buildCursorLaunch(ctx({ projectHasMcp: true })).writes!.map((w) => w.kind)).toEqual(['cursor-hooks']);
  });

  it('with everything present it writes nothing', () => {
    expect(buildCursorLaunch(ctx({ projectHasMcp: true, hooksPresent: true })).writes).toBeUndefined();
  });

  it.each([
    [{}],
    [{ projectHasMcp: true }],
    [{ passthrough: ['fix it'] }],
  ])('never passes --approve-mcps: approving servers is the user\'s call (%j)', (over) => {
    expect(buildCursorLaunch(ctx(over)).args).not.toContain('--approve-mcps');
  });

  it('passes the user\'s args through unchanged (two prompts)', () => {
    expect(buildCursorLaunch(ctx({ passthrough: ['fix it'] })).args).toEqual(['fix it']);
    expect(buildCursorLaunch(ctx({ passthrough: ['-p', 'hi'] })).args).toEqual(['-p', 'hi']);
  });
});
