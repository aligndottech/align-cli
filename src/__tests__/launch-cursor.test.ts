import { describe, expect, it } from 'vitest';
import { buildCursorLaunch, type CursorLaunchContext } from '../lib/launch/adapters/cursor.js';

/*
 * C4 Test List (Cursor adapter, pure builder; cursor-agent is NOT installed on the dev machine):
 *  1. nothing present: one align-local MCP write with an approval hint, and no flags
 *  2. the write is skipped when a local server is present; hooks are never written
 *  3. --approve-mcps is never passed (it approves every unapproved server, the user's own included)
 *  4. pass-through args are the whole of the args
 *  5. ALIGN_WRAPPED carried, no launch files
 */
const BASE: CursorLaunchContext = {
  passthrough: [],
  projectHasMcp: false,
  mcpFile: '/home/u/.cursor/mcp.json',
};
const ctx = (over: Partial<CursorLaunchContext> = {}): CursorLaunchContext => ({ ...BASE, ...over });

describe('buildCursorLaunch', () => {
  it('asks for the one MCP write and no flags when nothing is present', () => {
    const spec = buildCursorLaunch(ctx());
    expect(spec.bin).toBe('cursor-agent');
    expect(spec.args).toEqual([]);
    expect(spec.writes).toEqual([expect.objectContaining({ kind: 'mcp-entry', file: '/home/u/.cursor/mcp.json', topKey: 'mcpServers', name: 'align-local' })]);
    expect(spec.files).toEqual([]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
  });

  it('tells the user how to approve the new server (Cursor docs: agent mcp enable <name>)', () => {
    expect((buildCursorLaunch(ctx()).writes![0] as { hint: string }).hint).toContain('agent mcp enable align-local');
  });

  it('never writes CLI hooks: Cursor documents only workspaceOpen for the CLI (two contexts)', () => {
    for (const over of [{}, { projectHasMcp: true }]) {
      expect(JSON.stringify(buildCursorLaunch(ctx(over)).writes ?? [])).not.toMatch(/hooks/);
    }
  });

  it('the MCP entry targets the local graph and is never named align', () => {
    const w = buildCursorLaunch(ctx()).writes![0] as { name: string; entry: { args: string[] } };
    expect(w.name).toBe('align-local');
    expect(w.entry.args).toEqual(['mcp', '--env', 'local']);
  });

  it('projectHasMcp drops the write, and with it everything', () => {
    expect(buildCursorLaunch(ctx({ projectHasMcp: true })).writes).toBeUndefined();
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
