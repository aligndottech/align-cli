import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';
import { setupAgentAlignment } from '../lib/agent-rules.js';
import { mergeWrittenConfig, setWriteRecorder, type WrittenConfig } from '../lib/safe-config-write.js';

/*
 * ALI-1778 / ALI-1749. The first copy of a project file align edits (a committed AGENTS.md) is
 * kept OUTSIDE the repo, so `git status` after first run lists only align's own files and
 * `git add -A` cannot commit a backup. Undo still restores the file byte for byte.
 *
 * Test list (two examples per rule):
 *  a. committed AGENTS.md and CLAUDE.md: no *.align-backup in git status; undo is byte-identical and clean
 *  b. the backup sits under the state home, honouring XDG_STATE_HOME; undo removes it
 *  c. file absent: nothing is backed up
 *  d. a linked git worktree and a plain non-git directory behave the same
 *  e. the saved copy is missing at undo time: the file is left and the line names it
 *  f. the saved copy was changed: not trusted, the file is left
 */
let repo: string;
let stateHome: string;
let savedState: string | undefined;
let manifest: Record<string, WrittenConfig>;
let out: string[];
let errs: string[];

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
const read = (f: string, dir = repo) => readFileSync(path.join(dir, f), 'utf8');
const all = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
const backupsIn = (dir: string) => all(dir).filter((f) => f.includes('.align-backup'));

function deps(cwd: string): UseDeps {
  return {
    config: { getAgent: () => undefined, setAgent: () => {}, clearAgent: () => {}, setLaunchOff: () => {}, clearRefusedWrites: () => {} },
    findOnPath: () => null,
    writtenConfigs: { get: () => manifest, drop: (fs) => { for (const f of fs) delete manifest[f]; } },
    env: {},
    platform: process.platform,
    cwd,
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
  };
}
const firstRun = (cwd = repo) => setupAgentAlignment({ cwd, env: 'local' });
const undo = (cwd = repo) => runUse(undefined, deps(cwd), { undo: true });
const commitAll = (cwd = repo) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'init'); };

const AGENTS = '# Agents\n\nuser text, no trailing newline';
const CLAUDE = '# Mine\r\n\r\nKeep this.\r\n';

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'align-oor-'));
  stateHome = mkdtempSync(path.join(os.tmpdir(), 'align-oor-state-'));
  savedState = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = stateHome;
  manifest = {};
  out = [];
  errs = [];
  setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
  git(repo, 'init', '-q');
  // A Windows runner's global core.autocrlf=true would rewrite LF to CRLF in a linked worktree checkout, so pin it off.
  git(repo, 'config', 'core.autocrlf', 'false');
});
afterEach(() => {
  setWriteRecorder(undefined);
  if (savedState === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = savedState;
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
});

describe('project-file backups live outside the repo', () => {
  it('a. committed AGENTS.md and CLAUDE.md: git status never lists a backup, undo is byte-identical', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
    writeFileSync(path.join(repo, 'CLAUDE.md'), CLAUDE);
    commitAll();

    firstRun();
    const status = git(repo, 'status', '--porcelain');
    expect(status).not.toContain('align-backup');
    expect(status).toContain('AGENTS.md');
    expect(backupsIn(repo)).toEqual([]);

    expect(await undo()).toBe(0);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(repo, 'AGENTS.md'))).toEqual(Buffer.from(AGENTS));
    expect(readFileSync(path.join(repo, 'CLAUDE.md'))).toEqual(Buffer.from(CLAUDE));
    expect(errs).toEqual([]);
  });

  it('a2. a user-owned .claude/settings.json is backed up outside too, and comes back identical', async () => {
    const original = `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`;
    mkdirSync(path.join(repo, '.claude'), { recursive: true });
    writeFileSync(path.join(repo, '.claude/settings.json'), original);
    commitAll();

    firstRun();
    expect(git(repo, 'status', '--porcelain')).not.toContain('align-backup');
    expect(await undo()).toBe(0);
    expect(read('.claude/settings.json')).toBe(original);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('b. the copy sits under XDG_STATE_HOME and undo removes it', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
    firstRun();
    const kept = backupsIn(stateHome);
    expect(kept.length).toBe(1);
    expect(readFileSync(kept[0]!, 'utf8')).toBe(AGENTS);

    expect(await undo()).toBe(0);
    expect(backupsIn(stateHome)).toEqual([]);
    expect(all(stateHome)).toEqual([]);
    const root = path.join(stateHome, 'align-cli', 'undo-backups');
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]); // no empty directory per file left behind
  });

  it('b3. a re-run after the user edited the file keeps its extra snapshot outside the repo too', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
    commitAll();
    firstRun();
    writeFileSync(path.join(repo, 'AGENTS.md'), read('AGENTS.md').replace('<!-- align:end -->', 'added by the user\n<!-- align:end -->'));
    setupAgentAlignment({ cwd: repo, env: 'staging' });
    expect(git(repo, 'status', '--porcelain')).not.toContain('align-backup');
    expect(backupsIn(repo)).toEqual([]);
    expect(manifest[path.join(repo, 'AGENTS.md')]?.snapshots?.length).toBe(1);
    expect(backupsIn(stateHome).length).toBe(2); // the first copy and one snapshot
    expect(await undo()).toBe(0);
    expect(read('AGENTS.md')).not.toContain('align:start');
    expect(all(stateHome)).toEqual([]);
  });

  it('b2. two repos with an AGENTS.md each do not share a copy', async () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'align-oor-other-'));
    try {
      writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
      writeFileSync(path.join(other, 'AGENTS.md'), '# Other repo\n');
      firstRun();
      firstRun(other);
      expect(backupsIn(stateHome).map((f) => readFileSync(f, 'utf8')).sort()).toEqual(['# Other repo\n', AGENTS].sort());
      expect(await undo(other)).toBe(0);
      expect(read('AGENTS.md', other)).toBe('# Other repo\n');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('c. a file align creates needs no backup anywhere', () => {
    firstRun();
    expect(backupsIn(repo)).toEqual([]);
    expect(backupsIn(stateHome)).toEqual([]);
  });

  it('d. a linked git worktree: nothing in git status, undo clean', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
    commitAll();
    const wt = path.join(repo, '..', `${path.basename(repo)}-wt`);
    git(repo, 'worktree', 'add', '-q', '-b', 'wt', wt);
    try {
      firstRun(wt);
      expect(git(wt, 'status', '--porcelain')).not.toContain('align-backup');
      expect(await undo(wt)).toBe(0);
      expect(git(wt, 'status', '--porcelain')).toBe('');
      expect(read('AGENTS.md', wt)).toBe(AGENTS);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('d2. a directory that is not a git repo leaves no backup file beside the original', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'align-oor-plain-'));
    try {
      writeFileSync(path.join(plain, 'AGENTS.md'), AGENTS);
      firstRun(plain);
      expect(backupsIn(plain)).toEqual([]);
      expect(await undo(plain)).toBe(0);
      expect(read('AGENTS.md', plain)).toBe(AGENTS);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  const OLD_BLOCK = '<!-- align:start (managed by `align setup` - do not edit) -->\nolder wording\n<!-- align:end -->\n';

  it('e. the saved copy is gone and the original is not needed: align\'s block still comes out', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
    firstRun();
    for (const f of backupsIn(stateHome)) rmSync(f);

    expect(await undo()).toBe(0);
    expect(read('AGENTS.md')).not.toContain('align:start');
    expect(read('AGENTS.md').startsWith(AGENTS)).toBe(true); // the user's text is intact; only whitespace around the block may differ
    expect(errs).toEqual([]);
  });

  it('e2. the saved copy is gone and holds a block of the user\'s that align replaced: the file is left, the line names the copy', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), `# Agents\n\n${OLD_BLOCK}`);
    firstRun();
    const written = read('AGENTS.md');
    expect(written).not.toContain('older wording');
    for (const f of backupsIn(stateHome)) rmSync(f);

    expect(await undo()).toBe(1);
    expect(read('AGENTS.md')).toBe(written);
    expect(errs.join('\n')).toMatch(/AGENTS\.md.*saved copy.*missing/s);
    expect(manifest[path.join(repo, 'AGENTS.md')]).toBeDefined(); // still recorded, so undo can be run again
  });

  it('f. a saved copy that was changed is not trusted: the file is left', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), `# Agents\n\n${OLD_BLOCK}`);
    firstRun();
    const written = read('AGENTS.md');
    for (const f of backupsIn(stateHome)) writeFileSync(f, 'not what align saved');

    expect(await undo()).toBe(1);
    expect(read('AGENTS.md')).toBe(written);
    expect(errs.join('\n')).toMatch(/AGENTS\.md.*saved copy/s);
  });

  it('g. the user deleted the file before undo: its saved copy goes too, so a recreated file is backed up again', async () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
    firstRun();
    rmSync(path.join(repo, 'AGENTS.md'));
    expect(await undo()).toBe(0);
    expect(backupsIn(stateHome)).toEqual([]);

    writeFileSync(path.join(repo, 'AGENTS.md'), '# New\n');
    firstRun();
    expect(manifest[path.join(repo, 'AGENTS.md')]?.backup).toBe('made');
  });
});
