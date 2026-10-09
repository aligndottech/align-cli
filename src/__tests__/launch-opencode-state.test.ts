import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAgentsNudge, writeOpenCodePlugin } from '../lib/agent-rules.js';
import { readOpenCodeState } from '../lib/launch/opencode-state.js';

/*
 * C2 Test List (what OpenCode would already load, local equivalents only):
 *  1. empty project: nothing present
 *  2. plugin: setup's plugin counts when local is the default or --env local; --env prod does not; a
 *     foreign align.js does not; global ~/.config/opencode/plugins/align.js and an ancestor dir count
 *  3. mcp: opencode.json mcp.align targeting local counts; targeting prod, or a remote url, does not;
 *     the global file counts; an unparseable file is absent
 *  4. block: AGENTS.md (cwd, ancestor, global) or CLAUDE.md fallback carrying the managed block counts
 */
let root: string, cwd: string, home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-ocs-')));
  cwd = path.join(root, 'repo');
  home = path.join(root, 'home');
  mkdirSync(path.join(cwd, '.git'), { recursive: true });
  mkdirSync(home);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const put = (file: string, content: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const localDefault = { localIsDefault: true };
const cloudDefault = { localIsDefault: false };
const BLOCK = '<!-- align:start (managed by `align setup` - do not edit) -->\nx\n<!-- align:end -->\n';
const mcp = (command: string[]) => ({ mcp: { align: { type: 'local', command } } });

describe('readOpenCodeState', () => {
  it('reports nothing present in an empty project', () => {
    expect(readOpenCodeState(cwd, home, localDefault)).toEqual({ projectHasPlugin: false, projectHasMcp: false, projectHasBlock: false });
  });

  describe('plugin', () => {
    it('counts the plugin `align setup --local` wrote', () => {
      writeOpenCodePlugin(cwd, 'local');
      expect(readOpenCodeState(cwd, home, cloudDefault).projectHasPlugin).toBe(true);
    });
    it('counts a no-env plugin only when local is the default graph', () => {
      writeOpenCodePlugin(cwd);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasPlugin).toBe(true);
      expect(readOpenCodeState(cwd, home, cloudDefault).projectHasPlugin).toBe(false);
    });
    it('does not count a plugin aimed at another graph', () => {
      writeOpenCodePlugin(cwd, 'preview');
      expect(readOpenCodeState(cwd, home, localDefault).projectHasPlugin).toBe(false);
    });
    it('does not count a foreign align.js', () => {
      put(path.join(cwd, '.opencode', 'plugins', 'align.js'), 'export const X = async () => ({})');
      expect(readOpenCodeState(cwd, home, localDefault).projectHasPlugin).toBe(false);
    });
    it('counts the plugin in an ancestor dir and in the global config dir', () => {
      const sub = path.join(cwd, 'packages', 'a');
      mkdirSync(sub, { recursive: true });
      writeOpenCodePlugin(cwd, 'local');
      expect(readOpenCodeState(sub, home, localDefault).projectHasPlugin).toBe(true);
      rmSync(path.join(cwd, '.opencode'), { recursive: true });
      const other = path.join(root, 'other');
      writeOpenCodePlugin(other, 'local');
      mkdirSync(path.join(home, '.config', 'opencode', 'plugins'), { recursive: true });
      copyFileSync(path.join(other, '.opencode', 'plugins', 'align.js'), path.join(home, '.config', 'opencode', 'plugins', 'align.js'));
      expect(readOpenCodeState(cwd, home, localDefault).projectHasPlugin).toBe(true);
    });
  });

  describe('mcp', () => {
    it('counts an opencode.json mcp.align that reads the local graph', () => {
      put(path.join(cwd, 'opencode.json'), mcp(['align', 'mcp', '--env', 'local']));
      expect(readOpenCodeState(cwd, home, cloudDefault).projectHasMcp).toBe(true);
    });
    it('counts a no-env entry only when local is the default graph', () => {
      put(path.join(cwd, 'opencode.json'), mcp(['align', 'mcp']));
      expect(readOpenCodeState(cwd, home, localDefault).projectHasMcp).toBe(true);
      expect(readOpenCodeState(cwd, home, cloudDefault).projectHasMcp).toBe(false);
    });
    it('does not count an entry aimed at prod, or a remote server', () => {
      put(path.join(cwd, 'opencode.json'), mcp(['align', 'mcp', '--env', 'prod']));
      expect(readOpenCodeState(cwd, home, localDefault).projectHasMcp).toBe(false);
      put(path.join(cwd, 'opencode.json'), { mcp: { align: { type: 'remote', url: 'https://mcp.align.tech' } } });
      expect(readOpenCodeState(cwd, home, localDefault).projectHasMcp).toBe(false);
    });
    it('counts the global ~/.config/opencode/opencode.json and an ancestor project file', () => {
      put(path.join(home, '.config', 'opencode', 'opencode.json'), mcp(['align', 'mcp', '--env', 'local']));
      expect(readOpenCodeState(cwd, home, cloudDefault).projectHasMcp).toBe(true);
      rmSync(path.join(home, '.config'), { recursive: true });
      put(path.join(cwd, 'opencode.json'), mcp(['align', 'mcp', '--env', 'local']));
      const sub = path.join(cwd, 'x');
      mkdirSync(sub);
      expect(readOpenCodeState(sub, home, cloudDefault).projectHasMcp).toBe(true);
    });
    it('an align entry with enabled:false is not present (OpenCode will not start it), enabled:true is', () => {
      put(path.join(cwd, 'opencode.json'), { mcp: { align: { type: 'local', command: ['align', 'mcp', '--env', 'local'], enabled: false } } });
      expect(readOpenCodeState(cwd, home, localDefault).projectHasMcp).toBe(false);
      put(path.join(cwd, 'opencode.json'), { mcp: { align: { type: 'local', command: ['align', 'mcp', '--env', 'local'], enabled: true } } });
      expect(readOpenCodeState(cwd, home, localDefault).projectHasMcp).toBe(true);
    });
    it('treats an unparseable config as absent and never throws', () => {
      put(path.join(cwd, 'opencode.json'), '{ "mcp": ');
      expect(readOpenCodeState(cwd, home, localDefault).projectHasMcp).toBe(false);
    });
    it('honours an absolute XDG_CONFIG_HOME for the global file', () => {
      put(path.join(root, 'xdg', 'opencode', 'opencode.json'), mcp(['align', 'mcp', '--env', 'local']));
      expect(readOpenCodeState(cwd, home, cloudDefault, { XDG_CONFIG_HOME: path.join(root, 'xdg') }).projectHasMcp).toBe(true);
      expect(readOpenCodeState(cwd, home, cloudDefault, {}).projectHasMcp).toBe(false);
    });
  });

  describe('instructions block', () => {
    it('counts the managed block `align setup` writes to AGENTS.md', () => {
      writeAgentsNudge(cwd);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(true);
    });
    it('counts AGENTS.md in an ancestor, the global AGENTS.md, and the CLAUDE.md fallback', () => {
      const sub = path.join(cwd, 'x');
      mkdirSync(sub);
      put(path.join(cwd, 'AGENTS.md'), BLOCK);
      expect(readOpenCodeState(sub, home, localDefault).projectHasBlock).toBe(true);
      rmSync(path.join(cwd, 'AGENTS.md'));
      put(path.join(home, '.config', 'opencode', 'AGENTS.md'), BLOCK);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(true);
      rmSync(path.join(home, '.config'), { recursive: true });
      put(path.join(cwd, 'CLAUDE.md'), BLOCK);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(true);
    });
    it('the FIRST filename found wins: AGENTS.md without the block hides a CLAUDE.md that has it', () => {
      put(path.join(cwd, 'AGENTS.md'), '# notes\n');
      put(path.join(cwd, 'CLAUDE.md'), BLOCK);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(false);
    });
    it('CLAUDE.md counts only when no AGENTS.md exists up the tree, and CONTEXT.md after both', () => {
      put(path.join(cwd, 'CLAUDE.md'), BLOCK);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(true);
      rmSync(path.join(cwd, 'CLAUDE.md'));
      put(path.join(cwd, 'CONTEXT.md'), BLOCK);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(true);
    });
    it('CLAUDE.md is not read at all under OPENCODE_DISABLE_CLAUDE_CODE*', () => {
      put(path.join(cwd, 'CLAUDE.md'), BLOCK);
      expect(readOpenCodeState(cwd, home, localDefault, { OPENCODE_DISABLE_CLAUDE_CODE: '1' }).projectHasBlock).toBe(false);
      expect(readOpenCodeState(cwd, home, localDefault, { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1' }).projectHasBlock).toBe(false);
      expect(readOpenCodeState(cwd, home, localDefault, { OPENCODE_DISABLE_CLAUDE_CODE: '' }).projectHasBlock).toBe(true);
    });
    it('global: ~/.claude/CLAUDE.md is the fallback only when the global AGENTS.md is absent', () => {
      put(path.join(home, '.claude', 'CLAUDE.md'), BLOCK);
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(true);
      expect(readOpenCodeState(cwd, home, localDefault, { OPENCODE_DISABLE_CLAUDE_CODE: '1' }).projectHasBlock).toBe(false);
      put(path.join(home, '.config', 'opencode', 'AGENTS.md'), '# mine\n');
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(false);
    });
    it('does not count an AGENTS.md without the block', () => {
      put(path.join(cwd, 'AGENTS.md'), '# my notes\n');
      expect(readOpenCodeState(cwd, home, localDefault).projectHasBlock).toBe(false);
    });
  });
});
