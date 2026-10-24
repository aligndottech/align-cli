import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planAgentAlignment, setupAgentAlignment } from '../lib/agent-rules.js';
import { setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { type EditorTarget, mcpConfigFiles, writeMcpConfig } from '../lib/mcp-setup.js';
import { confirmWrites, planSetupWrites, renderWritePlan, WRITE_CONFIRM_QUESTION, WRITE_PLAN_HEADING, WRITE_UNDO_LINE } from '../lib/write-confirm.js';

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

  it('with no terminal: prints the list, never asks, goes ahead', async () => {
    const { ok, print, ask } = await run({ interactive: false, answer: false });
    expect(ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledTimes(1);
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
