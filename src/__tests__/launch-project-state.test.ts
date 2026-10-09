import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectState } from '../lib/launch/project-state.js';
import { writeClaudeCodeHook, writeManagedNudge, writeProjectMcpConfig } from '../lib/agent-rules.js';

let cwd: string, home: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'align-ps-cwd-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'align-ps-home-'));
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

describe('readProjectState', () => {
  it('reports nothing present in an empty project', () => {
    expect(readProjectState(cwd, home)).toEqual({ projectHasHooks: false, projectHasMcp: false, projectHasBlock: false });
  });
  it('sees what `align setup` wrote', () => {
    writeClaudeCodeHook(cwd);
    writeProjectMcpConfig(cwd);
    writeManagedNudge(cwd);
    expect(readProjectState(cwd, home)).toEqual({ projectHasHooks: true, projectHasMcp: true, projectHasBlock: true });
  });
  it('does not mistake the user\'s own hooks and servers for align\'s', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    writeFileSync(path.join(cwd, 'CLAUDE.md'), '# mine\n');
    expect(readProjectState(cwd, home)).toEqual({ projectHasHooks: false, projectHasMcp: false, projectHasBlock: false });
  });
  it('sees an align server in ~/.claude.json, top level or under this project', () => {
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { align: {} } }));
    expect(readProjectState(cwd, home).projectHasMcp).toBe(true);
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [cwd]: { mcpServers: { align: {} } } } }));
    expect(readProjectState(cwd, home).projectHasMcp).toBe(true);
  });
  it('treats unreadable JSON as absent rather than throwing', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{not json');
    expect(readProjectState(cwd, home).projectHasHooks).toBe(false);
  });
});
