import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planAgentAlignment, setupAgentAlignment } from '../lib/agent-rules.js';
import { setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { type EditorTarget, mcpConfigFiles, writeMcpConfig } from '../lib/mcp-setup.js';
import { confirmWrites, homeDisplay, planSetupWrites, renderWritePlan, USER_WIDE_HEADING, WRITE_CONFIRM_QUESTION, WRITE_NOT_APPROVED_LINE, WRITE_PLAN_HEADING, WRITE_UNDO_LINE } from '../lib/write-confirm.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'align-write-confirm-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the list is the plan the writer runs', () => {
  it('on a fresh repo, names exactly the files setupAgentAlignment writes, in order', () => {
    const planned = planAgentAlignment(dir).map((p) => p.file);
    expect(planned.length).toBeGreaterThan(0); // positive control: an empty plan would equal an empty write
    const written = setupAgentAlignment({ cwd: dir, env: 'local' });
    expect(written).toEqual(planned);
  });

  it('calls a file that exists "modify" and one that does not "create"', () => {
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# mine\n');
    const byFile = Object.fromEntries(planAgentAlignment(dir).map((p) => [p.file, p.action]));
    expect(byFile['CLAUDE.md']).toBe('modify');
    expect(byFile['AGENTS.md']).toBe('create');
  });

  it('after a run, every file it names exists on disk', () => {
    const planned = planAgentAlignment(dir).map((p) => p.file);
    setupAgentAlignment({ cwd: dir, env: 'local' });
    for (const f of planned) expect(planAgentAlignment(dir).find((p) => p.file === f)?.action).toBe('modify');
  });

  it('adds each detected agent\'s own config and hook file, the paths writeMcpConfig writes', () => {
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    const target: EditorTarget = {
      name: 'Codex',
      configPath: path.join(home, '.codex', 'config.toml'),
      format: 'codex',
      hooks: { host: 'codex', path: path.join(home, '.codex', 'hooks.json') },
    };
    const plan = planSetupWrites({ cwd: path.join(dir, 'repo'), editors: [target], home });
    expect(plan.map((p) => p.display)).toEqual(expect.arrayContaining(['~/.codex/config.toml', '~/.codex/hooks.json']));
    expect(mcpConfigFiles(target)).toEqual([target.configPath, target.hooks!.path]);
    expect(writeMcpConfig(target, 'local')).toEqual(mcpConfigFiles(target));
  });

  it('marks the project\'s own files "project" and an agent\'s config under home "user"', () => {
    const home = path.join(dir, 'home');
    const repo = path.join(dir, 'repo');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    const target: EditorTarget = {
      name: 'Codex',
      configPath: path.join(home, '.codex', 'config.toml'),
      format: 'codex',
      hooks: { host: 'codex', path: path.join(home, '.codex', 'hooks.json') },
    };
    const plan = planSetupWrites({ cwd: repo, editors: [target], home });
    const scopeOf = Object.fromEntries(plan.map((p) => [p.display, p.scope]));
    expect(scopeOf['~/.codex/hooks.json']).toBe('user');
    expect(scopeOf['~/.codex/config.toml']).toBe('user');
    const projectRows = plan.filter((p) => p.scope === 'project');
    expect(projectRows.length).toBeGreaterThan(0); // positive control: the project rows exist
    for (const p of projectRows) expect(p.file.startsWith(repo)).toBe(true);
  });

  it('an agent config file inside the project (a workspace .mcp.json) stays "project"', () => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const t: EditorTarget = { name: 'VS Code', configPath: path.join(repo, '.vscode', 'mcp.json'), format: 'mcpServers' };
    const plan = planSetupWrites({ cwd: repo, editors: [t], home: path.join(dir, 'home') });
    expect(plan.find((p) => p.file === t.configPath)?.scope).toBe('project');
  });

  it('run from home itself, an agent\'s own config is still "user"', () => {
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    const target: EditorTarget = { name: 'Codex', configPath: path.join(home, '.codex', 'config.toml'), format: 'codex' };
    const plan = planSetupWrites({ cwd: home, editors: [target], home });
    expect(plan.find((p) => p.file === target.configPath)?.scope).toBe('user');
  });

  it('lists a path once even when two sources name it', () => {
    const t: EditorTarget = { name: 'A', configPath: path.join(dir, 'a.json'), format: 'mcpServers' };
    const plan = planSetupWrites({ cwd: dir, editors: [t, { ...t, name: 'B' }], home: dir });
    expect(plan.filter((p) => p.file === t.configPath)).toHaveLength(1);
  });
});

describe('renderWritePlan', () => {
  it('prints one aligned line per file with its action', () => {
    const text = renderWritePlan([
      { file: '/r/CLAUDE.md', display: 'CLAUDE.md', action: 'modify' },
      { file: '/r/.mcp.json', display: '.mcp.json', action: 'create' },
    ]);
    expect(text.split('\n')).toEqual([
      'Align may create or change these files:',
      '  modify  CLAUDE.md',
      '  create  .mcp.json',
    ]);
  });

  it('puts user-wide files under their own heading that says they affect every project', () => {
    const text = renderWritePlan([
      { file: '/h/.codex/hooks.json', display: '~/.codex/hooks.json', action: 'create', scope: 'user' },
      { file: '/r/CLAUDE.md', display: 'CLAUDE.md', action: 'modify', scope: 'project' },
    ]);
    expect(text.split('\n')).toEqual([
      'Align may create or change these files:',
      '  modify  CLAUDE.md',
      USER_WIDE_HEADING,
      '  create  ~/.codex/hooks.json',
    ]);
    expect(USER_WIDE_HEADING).toContain('every project');
  });
});

describe('confirmWrites', () => {
  const files = [{ file: '/r/.mcp.json', display: '.mcp.json', action: 'create' as const }];
  const run = (o: { interactive: boolean; approve?: boolean; answer?: boolean | undefined }) => {
    const print = vi.fn();
    const ask = vi.fn(async () => o.answer);
    return confirmWrites({ files, interactive: o.interactive, approve: o.approve, print, ask }).then((ok) => ({ ok, print, ask }));
  };

  it('asks "Continue?" after printing the list and the undo, and goes ahead on yes', async () => {
    const { ok, print, ask } = await run({ interactive: true, answer: true });
    expect(ok).toBe(true);
    expect(ask).toHaveBeenCalledWith(WRITE_CONFIRM_QUESTION);
    const shown = String(print.mock.calls[0]![0]);
    expect(shown).toContain('create  .mcp.json');
    expect(shown).toContain(WRITE_UNDO_LINE);
    expect(WRITE_UNDO_LINE).toContain('align use --undo');
  });

  it('returns false when the person says no', async () => {
    expect((await run({ interactive: true, answer: false })).ok).toBe(false);
  });

  it('returns false when the person cancels', async () => {
    expect((await run({ interactive: true, answer: undefined })).ok).toBe(false);
  });

  it('with --approve: prints the list, never asks, goes ahead', async () => {
    const { ok, print, ask } = await run({ interactive: true, approve: true, answer: false });
    expect(ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledTimes(1);
  });

  // an agent running `align` in its own shell has no terminal. Nobody said yes, so
  // nothing is written; the list still prints, with the flag that would allow it.
  it('with no terminal and no --approve: prints the list, never asks, writes nothing, names --approve', async () => {
    const { ok, print, ask } = await run({ interactive: false, answer: true });
    expect(ok).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    const shown = print.mock.calls.map((c) => String(c[0])).join('\n');
    expect(shown).toContain('create  .mcp.json');
    expect(shown).toContain(WRITE_NOT_APPROVED_LINE);
    expect(WRITE_NOT_APPROVED_LINE).toContain('--approve');
  });

  it('with no terminal but --approve: goes ahead, the flag is the yes', async () => {
    const { ok, ask } = await run({ interactive: false, approve: true, answer: false });
    expect(ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('has nothing to ask about when no file would be written', async () => {
    const print = vi.fn();
    const ask = vi.fn();
    expect(await confirmWrites({ files: [], interactive: true, print, ask })).toBe(true);
    expect(print).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('the undo line says what `align use --undo` really undoes', () => {
  it('undo reverts every file the list names: the project files and each agent\'s own config', () => {
    const home = path.join(dir, 'home');
    const repo = path.join(dir, 'repo');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    const stateBefore = process.env['XDG_STATE_HOME'];
    process.env['XDG_STATE_HOME'] = path.join(dir, 'state'); // undo backups land here, not in the real state dir
    const manifest: Record<string, WrittenConfig> = {};
    setWriteRecorder((file, entry) => { manifest[file] = { ...manifest[file], ...entry }; });
    try {
      const editor: EditorTarget = {
        name: 'Codex',
        configPath: path.join(home, '.codex', 'config.toml'),
        format: 'codex',
        hooks: { host: 'codex', path: path.join(home, '.codex', 'hooks.json') },
      };
      const plan = planSetupWrites({ cwd: repo, editors: [editor], home });
      const global = plan.filter((p) => p.file.startsWith(home));
      expect(global.length).toBe(2); // positive control: the plan holds global agent files, not only project ones
      expect(plan.length).toBeGreaterThan(global.length);
      const wroteProject = setupAgentAlignment({ cwd: repo, env: 'local' });
      const wroteGlobal = writeMcpConfig(editor, 'local');
      const written = [...wroteProject.map((f) => path.join(repo, f)), ...wroteGlobal];
      expect(written.length).toBe(plan.length); // every listed file was written
      for (const f of written) expect(existsSync(f)).toBe(true);

      const report = undoWrittenConfigs(manifest);
      expect(report.skipped).toEqual([]);
      for (const f of written) expect(report.done, `${f} is listed but --undo did not finish it`).toContain(f);
    } finally {
      setWriteRecorder(undefined);
      if (stateBefore === undefined) delete process.env['XDG_STATE_HOME']; else process.env['XDG_STATE_HOME'] = stateBefore;
    }
  });

  it('the line names align use --undo and claims the scope that test proved', () => {
    expect(WRITE_UNDO_LINE).toContain('align use --undo');
    expect(WRITE_UNDO_LINE).toMatch(/every file listed, project and agent config alike/);
  });

  it('the heading says "may", because a writer can leave a symlink or team entry untouched', () => {
    expect(WRITE_PLAN_HEADING).toBe('Align may create or change these files:');
  });
});

describe('homeDisplay: a home path reads ~/... on every OS', () => {
  it('turns a Windows home path into forward slashes (CI only runs this OS on main)', () => {
    expect(homeDisplay('C:\\Users\\tom\\.codex\\config.toml', 'C:\\Users\\tom')).toBe('~/.codex/config.toml');
  });
  it('leaves a POSIX home path as it is', () => {
    expect(homeDisplay('/home/tom/.codex/hooks.json', '/home/tom')).toBe('~/.codex/hooks.json');
  });
  it('does not shorten a path outside home, or a sibling that only shares the prefix', () => {
    expect(homeDisplay('/opt/x/config.toml', '/home/tom')).toBe('/opt/x/config.toml');
    expect(homeDisplay('/home/tomas/.codex/config.toml', '/home/tom')).toBe('/home/tomas/.codex/config.toml');
  });
});
