import { describe, expect, it } from 'vitest';
import { buildCursorLaunch, type CursorLaunchContext } from '../lib/launch/adapters/cursor.js';

/*
 * C4 Test List (Cursor adapter, pure builder; cursor-agent is NOT installed on the dev machine):
 *  1. nothing present: an align-local MCP write and a hooks write, and --approve-mcps
 *  2. each write is skipped on its own flag, both sides (mcp / hooks)
 *  3. --approve-mcps only when the entry is ours: requested or already there; not for a user's own server
 *  4. pass-through first, injected last, a literal -- keeps our flag before it
 *  5. ALIGN_WRAPPED carried, no launch files
 */
const BASE: CursorLaunchContext = {
  passthrough: [],
  hasAlignLocalEntry: false,
  projectHasMcp: false,
  hooksPresent: false,
  mcpFile: '/home/u/.cursor/mcp.json',
  hooksFile: '/home/u/.cursor/hooks.json',
};
const ctx = (over: Partial<CursorLaunchContext> = {}): CursorLaunchContext => ({ ...BASE, ...over });

describe('buildCursorLaunch', () => {
  it('asks for both writes and the approval flag when nothing is present', () => {
    const spec = buildCursorLaunch(ctx());
    expect(spec.bin).toBe('cursor-agent');
    expect(spec.args).toEqual(['--approve-mcps']);
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

  it('passes --approve-mcps when our entry is already there, but not when only the user\'s own align server is', () => {
    expect(buildCursorLaunch(ctx({ projectHasMcp: true, hasAlignLocalEntry: true })).args).toEqual(['--approve-mcps']);
    expect(buildCursorLaunch(ctx({ projectHasMcp: true, hasAlignLocalEntry: false })).args).toEqual([]);
  });

  it('puts the user\'s args first and ours last (two prompts)', () => {
    expect(buildCursorLaunch(ctx({ passthrough: ['fix it'] })).args).toEqual(['fix it', '--approve-mcps']);
    expect(buildCursorLaunch(ctx({ passthrough: ['-p', 'hi'] })).args).toEqual(['-p', 'hi', '--approve-mcps']);
  });

  it('keeps --approve-mcps before a literal --', () => {
    expect(buildCursorLaunch(ctx({ passthrough: ['--', 'x'] })).args).toEqual(['--approve-mcps', '--', 'x']);
  });
});
