import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALIGN_NUDGE_START, piExtensionBody } from '../lib/agent-rules.js';
import { readCursorState } from '../lib/launch/cursor-state.js';
import { readPiState } from '../lib/launch/pi-state.js';

/*
 * C4 Test List (what pi / Cursor would already load):
 *  pi: extension in .pi/extensions (project, ancestor, agent dir) counts only when aimed at the local graph;
 *      an extension aimed at prod does not; PI_CODING_AGENT_DIR moves the agent dir and mcp.json path;
 *      an align-local or local `align` server in mcp.json or .mcp.json counts, a prod one does not;
 *      the managed block in AGENTS.md / CLAUDE.md counts.
 *  Cursor: align-local key counts and is reported as ours; a user's local `align` counts but is not ours;
 *      hooks count only when BOTH events carry a local check.
 */
let root: string, cwd: string, home: string;
const put = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-state-')));
  cwd = path.join(root, 'repo'); home = path.join(root, 'home');
  mkdirSync(path.join(cwd, '.git'), { recursive: true }); mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const server = (args: string[]) => JSON.stringify({ mcpServers: { align: { command: 'align', args } } });

describe('readPiState', () => {
  const read = (env: Record<string, string | undefined> = {}) => readPiState(cwd, home, { localIsDefault: false }, env);

  it('reports nothing for a bare project, and where mcp.json would go', () => {
    expect(read()).toEqual({ projectHasExtension: false, projectHasMcp: false, projectHasBlock: false, mcpFile: path.join(home, '.pi', 'agent', 'mcp.json') });
  });

  it('counts a project extension aimed at the local graph, not one aimed at prod', () => {
    put(path.join(cwd, '.pi', 'extensions', 'align.ts'), piExtensionBody('local'));
    expect(read().projectHasExtension).toBe(true);
    put(path.join(cwd, '.pi', 'extensions', 'align.ts'), piExtensionBody());
    expect(read().projectHasExtension).toBe(false);
  });

  it('finds the extension in the agent dir too, and PI_CODING_AGENT_DIR moves that dir and the mcp.json path', () => {
    const dir = path.join(root, 'elsewhere');
    put(path.join(dir, 'extensions', 'align.ts'), piExtensionBody('local'));
    expect(read().projectHasExtension).toBe(false);
    const s = read({ PI_CODING_AGENT_DIR: dir });
    expect(s.projectHasExtension).toBe(true);
    expect(s.mcpFile).toBe(path.join(dir, 'mcp.json'));
  });

  it('a prod extension counts as local when local is the default env', () => {
    put(path.join(cwd, '.pi', 'extensions', 'align.ts'), piExtensionBody());
    expect(readPiState(cwd, home, { localIsDefault: true }, {}).projectHasExtension).toBe(true);
  });

  it('counts an align-local entry or a local align server, in either file; a prod align server does not count', () => {
    put(path.join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { 'align-local': { command: 'x' } } }));
    expect(read().projectHasMcp).toBe(true);
    rmSync(path.join(home, '.pi'), { recursive: true });
    put(path.join(cwd, '.mcp.json'), server(['mcp', '--env', 'local']));
    expect(read().projectHasMcp).toBe(true);
    put(path.join(cwd, '.mcp.json'), server(['mcp']));
    expect(read().projectHasMcp).toBe(false);
  });

  it('counts the managed block in an ancestor AGENTS.md or the agent dir\'s', () => {
    put(path.join(cwd, 'AGENTS.md'), `x\n${ALIGN_NUDGE_START}\n`);
    expect(read().projectHasBlock).toBe(true);
    rmSync(path.join(cwd, 'AGENTS.md'));
    put(path.join(home, '.pi', 'agent', 'AGENTS.md'), ALIGN_NUDGE_START);
    expect(read().projectHasBlock).toBe(true);
    rmSync(path.join(home, '.pi'), { recursive: true });
    expect(read().projectHasBlock).toBe(false);
  });
});

describe('readCursorState', () => {
  const read = () => readCursorState(cwd, home, { localIsDefault: false });
  const hooks = (pre: string, post: string) => JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: pre }], postToolUse: [{ command: post }] } });

  it('reports nothing for a bare machine, and the global files it would add to', () => {
    expect(read()).toEqual({ projectHasMcp: false, hooksPresent: false, mcpFile: path.join(home, '.cursor', 'mcp.json'), hooksFile: path.join(home, '.cursor', 'hooks.json') });
  });

  it('an align-local key and a user\'s local align server both count as present', () => {
    put(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'align-local': { command: 'align' } } }));
    expect(read()).toMatchObject({ projectHasMcp: true });
    put(path.join(home, '.cursor', 'mcp.json'), server(['mcp', '--env', 'local']));
    expect(read()).toMatchObject({ projectHasMcp: true });
    put(path.join(home, '.cursor', 'mcp.json'), server(['mcp']));
    expect(read()).toMatchObject({ projectHasMcp: false });
  });

  it('reads the project .cursor/mcp.json as well', () => {
    put(path.join(cwd, '.cursor', 'mcp.json'), server(['mcp', '--env', 'local']));
    expect(read().projectHasMcp).toBe(true);
  });

  it('hooks count only when both events carry a local check', () => {
    const local = 'align check --advisory --format cursor --env local';
    put(path.join(home, '.cursor', 'hooks.json'), hooks(local, local));
    expect(read().hooksPresent).toBe(true);
    put(path.join(home, '.cursor', 'hooks.json'), hooks(local, 'other'));
    expect(read().hooksPresent).toBe(false);
    put(path.join(home, '.cursor', 'hooks.json'), hooks('align check --advisory --format cursor', 'align check --advisory --format cursor'));
    expect(read().hooksPresent).toBe(false);
  });
});
