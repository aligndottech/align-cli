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

const trust = (agentDir: string, map: Record<string, boolean>) => put(path.join(agentDir, 'trust.json'), JSON.stringify(map));
const agentDefault = () => path.join(home, '.pi', 'agent');

describe('readPiState', () => {
  const read = (env: Record<string, string | undefined> = {}) => readPiState(cwd, home, { localIsDefault: false }, env);
  const putExt = (body: string) => put(path.join(cwd, '.pi', 'extensions', 'align.ts'), body);

  it('reports nothing for a bare project, and where mcp.json would go', () => {
    expect(read()).toEqual({ projectHasExtension: false, projectHasMcp: false, projectHasBlock: false, mcpAdapterInstalled: false, mcpFile: path.join(agentDefault(), 'mcp.json') });
  });

  it('a project extension counts only in a project pi trusts (README "Project Trust"); untrusted, explicitly distrusted or undecided it does not', () => {
    putExt(piExtensionBody('local'));
    expect(read().projectHasExtension).toBe(false); // no decision: pi asks, or ignores it when non-interactive
    trust(agentDefault(), { [cwd]: true });
    expect(read().projectHasExtension).toBe(true);
    trust(agentDefault(), { [cwd]: false });
    expect(read().projectHasExtension).toBe(false);
  });

  it('trust is the nearest saved decision, a parent folder included', () => {
    putExt(piExtensionBody('local'));
    trust(agentDefault(), { [root]: true });
    expect(read().projectHasExtension).toBe(true);
    trust(agentDefault(), { [root]: true, [cwd]: false });
    expect(read().projectHasExtension).toBe(false);
  });

  it('defaultProjectTrust "always" trusts an undecided project; "ask" and "never" do not', () => {
    putExt(piExtensionBody('local'));
    put(path.join(agentDefault(), 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
    expect(read().projectHasExtension).toBe(true);
    put(path.join(agentDefault(), 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never' }));
    expect(read().projectHasExtension).toBe(false);
  });

  it('an unreadable trust.json means untrusted, so the extension is injected', () => {
    putExt(piExtensionBody('local'));
    put(path.join(agentDefault(), 'trust.json'), '{ broken');
    expect(read().projectHasExtension).toBe(false);
  });

  it('a trusted project extension aimed at prod does not count; a prod one counts when local is the default env', () => {
    trust(agentDefault(), { [cwd]: true });
    putExt(piExtensionBody());
    expect(read().projectHasExtension).toBe(false);
    expect(readPiState(cwd, home, { localIsDefault: true }, {}).projectHasExtension).toBe(true);
  });

  it('the extension in the agent dir needs no trust, and PI_CODING_AGENT_DIR moves that dir and the mcp.json path', () => {
    const dir = path.join(root, 'elsewhere');
    put(path.join(dir, 'extensions', 'align.ts'), piExtensionBody('local'));
    expect(read().projectHasExtension).toBe(false);
    const s = read({ PI_CODING_AGENT_DIR: dir });
    expect(s.projectHasExtension).toBe(true);
    expect(s.mcpFile).toBe(path.join(dir, 'mcp.json'));
  });

  it('counts an align-local entry or a local align server, in either file; a prod align server does not count', () => {
    put(path.join(agentDefault(), 'mcp.json'), JSON.stringify({ mcpServers: { 'align-local': { command: 'x' } } }));
    expect(read().projectHasMcp).toBe(true);
    rmSync(path.join(home, '.pi'), { recursive: true });
    put(path.join(cwd, '.mcp.json'), server(['mcp', '--env', 'local']));
    expect(read().projectHasMcp).toBe(true);
    put(path.join(cwd, '.mcp.json'), server(['mcp']));
    expect(read().projectHasMcp).toBe(false);
  });

  it('pi-mcp-adapter counts as installed from the user settings, as a string or a {source}, and not otherwise', () => {
    put(path.join(agentDefault(), 'settings.json'), JSON.stringify({ packages: ['pi-skills', 'npm:pi-mcp-adapter@1.2.0'] }));
    expect(read().mcpAdapterInstalled).toBe(true);
    put(path.join(agentDefault(), 'settings.json'), JSON.stringify({ packages: [{ source: 'pi-mcp-adapter', skills: [] }] }));
    expect(read().mcpAdapterInstalled).toBe(true);
    put(path.join(agentDefault(), 'settings.json'), JSON.stringify({ packages: ['pi-skills'] }));
    expect(read().mcpAdapterInstalled).toBe(false);
  });

  it('the managed block counts in the agent dir\'s AGENTS.md and in a parent ABOVE the git root', () => {
    put(path.join(root, 'AGENTS.md'), `x\n${ALIGN_NUDGE_START}\n`); // root is the parent of the repo (which holds .git)
    expect(read().projectHasBlock).toBe(true);
    rmSync(path.join(root, 'AGENTS.md'));
    put(path.join(agentDefault(), 'AGENTS.md'), ALIGN_NUDGE_START);
    expect(read().projectHasBlock).toBe(true);
    rmSync(path.join(home, '.pi'), { recursive: true });
    expect(read().projectHasBlock).toBe(false);
  });

  it('AGENTS.override.md replaces AGENTS.md and CLAUDE.md in its directory (README "Context Files")', () => {
    put(path.join(cwd, 'AGENTS.md'), ALIGN_NUDGE_START);
    put(path.join(cwd, 'AGENTS.override.md'), 'only this is loaded');
    expect(read().projectHasBlock).toBe(false);
    put(path.join(cwd, 'AGENTS.override.md'), ALIGN_NUDGE_START);
    expect(read().projectHasBlock).toBe(true);
  });
});

describe('readCursorState', () => {
  const read = () => readCursorState(cwd, home, { localIsDefault: false });

  it('reports nothing for a bare machine, and the global file it would add to', () => {
    expect(read()).toEqual({ projectHasMcp: false, mcpFile: path.join(home, '.cursor', 'mcp.json') });
  });

  it('an align-local key and a user\'s local align server both count as present; a prod one does not', () => {
    put(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'align-local': { command: 'align' } } }));
    expect(read().projectHasMcp).toBe(true);
    put(path.join(home, '.cursor', 'mcp.json'), server(['mcp', '--env', 'local']));
    expect(read().projectHasMcp).toBe(true);
    put(path.join(home, '.cursor', 'mcp.json'), server(['mcp']));
    expect(read().projectHasMcp).toBe(false);
  });

  it('reads the project .cursor/mcp.json as well', () => {
    put(path.join(cwd, '.cursor', 'mcp.json'), server(['mcp', '--env', 'local']));
    expect(read().projectHasMcp).toBe(true);
  });
});
