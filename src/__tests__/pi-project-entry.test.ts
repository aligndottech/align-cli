import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupAgentAlignment, writeProjectMcpConfig } from '../lib/agent-rules.js';
import { readPiState } from '../lib/launch/pi-state.js';

/*
 * The entry pi loads in a trusted project has to be pi's own project file, and it has to
 * ask for direct exposure: pi defaults an MCP server to codemode exposure, where its tools
 * are hidden from the model's tool list, and the shared .mcp.json is host-neutral by
 * contract. So .pi/mcp.json carries the exposed entry and .mcp.json keeps its bytes.
 */
let root: string, cwd: string, home: string;
const agentDir = () => path.join(home, '.pi', 'agent');
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const piFile = () => path.join(cwd, '.pi', 'mcp.json');
const sharedFile = () => path.join(cwd, '.mcp.json');

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'align-pi-entry-'));
  cwd = path.join(root, 'repo');
  home = path.join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  put(path.join(agentDir(), 'trust.json'), JSON.stringify({ [cwd]: true }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the align entry pi loads in a trusted project', () => {
  it('asks for direct exposure in pi\'s own file, and keeps the shared file free of pi keys', () => {
    writeProjectMcpConfig(cwd);
    const shared = readFileSync(sharedFile(), 'utf8');
    setupAgentAlignment({ cwd });
    expect(readJson(piFile()).mcpServers.align).toEqual({ command: 'align', args: ['mcp'], exposure: 'direct' });
    expect(readJson(sharedFile()).mcpServers.align).toEqual({ command: 'align', args: ['mcp'] });
    expect(shared).not.toContain('exposure');
    expect(readFileSync(sharedFile(), 'utf8')).toBe(shared);
  });

  it('counts as the align server a pi launch already has when only pi\'s own file declares it', () => {
    setupAgentAlignment({ cwd });
    rmSync(sharedFile());
    expect(readPiState(cwd, home, { localIsDefault: true }, {})).toMatchObject({ projectHasMcp: true });
  });

  it('is idempotent: a second setup leaves both files with the same bytes', () => {
    setupAgentAlignment({ cwd });
    const pi = readFileSync(piFile(), 'utf8');
    const shared = readFileSync(sharedFile(), 'utf8');
    setupAgentAlignment({ cwd });
    expect(readFileSync(piFile(), 'utf8')).toBe(pi);
    expect(readFileSync(sharedFile(), 'utf8')).toBe(shared);
  });

  it('leaves a team entry in pi\'s file alone when the setup run is local, and says which file', () => {
    const team = JSON.stringify({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'], exposure: 'direct' } } });
    put(piFile(), team);
    const foreign: string[] = [];
    setupAgentAlignment({ cwd, env: 'local', onForeign: (f) => foreign.push(f) });
    expect(readFileSync(piFile(), 'utf8')).toBe(team);
    expect(foreign).toContain(path.join('.pi', 'mcp.json'));
  });

  // pi's own file outranks .mcp.json, so an entry naming the local graph there would move every
  // teammate's pi off the destination the shared file was protected to keep.
  it('names the team destination, not the local graph, when the shared file keeps a team entry', () => {
    const team = { command: 'align', args: ['mcp', '--env', 'prod'] };
    put(sharedFile(), JSON.stringify({ mcpServers: { align: team } }));
    const sharedBytes = readFileSync(sharedFile(), 'utf8');
    const foreign: string[] = [];
    setupAgentAlignment({ cwd, env: 'local', onForeign: (f) => foreign.push(f) });
    expect(readJson(piFile()).mcpServers.align).toEqual({ ...team, exposure: 'direct' });
    expect(readFileSync(sharedFile(), 'utf8')).toBe(sharedBytes);
    expect(foreign).toContain('.mcp.json');
    const piBytes = readFileSync(piFile(), 'utf8');
    setupAgentAlignment({ cwd, env: 'local', onForeign: (f) => foreign.push(f) });
    expect(readFileSync(piFile(), 'utf8')).toBe(piBytes);
  });

  it('merges into a pi file that already holds other servers and unrelated keys', () => {
    const other = { command: 'other-server', args: ['--x'] };
    put(piFile(), JSON.stringify({ mcpServers: { other }, generatedBy: 'team-config' }));
    setupAgentAlignment({ cwd });
    const file = readJson(piFile());
    expect(file.mcpServers.other).toEqual(other);
    expect(file.generatedBy).toBe('team-config');
    expect(file.mcpServers.align).toEqual({ command: 'align', args: ['mcp'], exposure: 'direct' });
  });
});
