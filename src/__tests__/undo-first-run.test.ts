import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';
import { setupAgentAlignment } from '../lib/agent-rules.js';
import { mergeWrittenConfig, setWriteRecorder, type WrittenConfig } from '../lib/safe-config-write.js';

/*
 * ALI-1778 / ALI-1749. What first run writes into a repo, `align use --undo` takes back out.
 * The real writer (setupAgentAlignment) runs in a temp repo with the real recorder shape; the
 * real undo (runUse --undo) reads the ledger it filled.
 *
 * Test list:
 *  a. fresh repo + a committed AGENTS.md: undo leaves git status clean and AGENTS.md identical
 *  b. a CLAUDE.md with the user's own content: the block goes, the content stays byte for byte
 *  c. a file align created and the user then edited: left in place and named
 *  d. undo twice: the second run says there is nothing to undo
 *  e. "Nothing to undo" is not printed while align's files sit in the repo with no record
 */
let repo: string;
let manifest: Record<string, WrittenConfig>;
let out: string[];
let errs: string[];

const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
const read = (f: string) => readFileSync(path.join(repo, f), 'utf8');
const files = (dir = repo, base = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? [`${base}${e.name}/`, ...files(path.join(dir, e.name), `${base}${e.name}/`)] : [`${base}${e.name}`])).sort();

function deps(over: Partial<UseDeps> = {}): UseDeps {
  return {
    config: { getAgent: () => undefined, setAgent: () => {}, clearAgent: () => {}, setLaunchOff: () => {}, clearRefusedWrites: () => {} },
    findOnPath: () => null,
    writtenConfigs: { get: () => manifest, drop: (fs) => { for (const f of fs) delete manifest[f]; } },
    env: {},
    platform: process.platform,
    cwd: repo,
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
    ...over,
  };
}
const firstRun = () => setupAgentAlignment({ cwd: repo, env: 'local' });
const undo = () => runUse(undefined, deps(), { undo: true });

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'align-undo-'));
  manifest = {};
  out = [];
  errs = [];
  setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
  git('init', '-q');
});
afterEach(() => {
  setWriteRecorder(undefined);
  rmSync(repo, { recursive: true, force: true });
});

describe('undo after first run', () => {
  it('a. leaves the working tree as it was, with a pre-existing AGENTS.md byte-identical', async () => {
    const original = '# Agents\n\nuser text, no trailing newline';
    writeFileSync(path.join(repo, 'AGENTS.md'), original);
    git('add', '-A');
    git('commit', '-qm', 'init');
    const before = files();

    firstRun();
    expect(git('status', '--porcelain')).not.toBe('');
    expect(Object.keys(manifest).length).toBeGreaterThanOrEqual(8);

    expect(await undo()).toBe(0);
    expect(git('status', '--porcelain')).toBe('');
    expect(read('AGENTS.md')).toBe(original);
    expect(files()).toEqual(before); // no leftover backups, no empty .claude/.cursor/... directories
    expect(errs).toEqual([]);
  });

  it('b. takes the block out of a CLAUDE.md that holds the user\'s content and nothing else', async () => {
    const original = '# Mine\n\nKeep this.\n\n## Also mine\n- one\n';
    writeFileSync(path.join(repo, 'CLAUDE.md'), original);
    git('add', '-A');
    git('commit', '-qm', 'init');

    firstRun();
    expect(read('CLAUDE.md')).toContain('align:start');

    expect(await undo()).toBe(0);
    expect(read('CLAUDE.md')).toBe(original);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('b2. keeps what the user added to a CLAUDE.md after align wrote its block', async () => {
    writeFileSync(path.join(repo, 'CLAUDE.md'), '# Mine\n');
    firstRun();
    writeFileSync(path.join(repo, 'CLAUDE.md'), `${read('CLAUDE.md')}\n## Added later\nstay\n`);

    expect(await undo()).toBe(0);
    expect(read('CLAUDE.md')).toContain('## Added later\nstay');
    expect(read('CLAUDE.md')).not.toContain('align:start');
  });

  it('b3. a CLAUDE.md align created and nobody touched is deleted, not left empty', async () => {
    firstRun();
    expect(await undo()).toBe(0);
    expect(existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false);
  });

  it('b4. a created CLAUDE.md that only gained blank lines is still deleted once the block is out', async () => {
    firstRun();
    writeFileSync(path.join(repo, 'CLAUDE.md'), `${read('CLAUDE.md')}\n\n`);
    expect(await undo()).toBe(0);
    expect(existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false);
  });

  it('c. leaves a file align created and the user then edited, and names it', async () => {
    firstRun();
    writeFileSync(path.join(repo, '.cursor/rules/align.md'), `${read('.cursor/rules/align.md')}my own rule\n`);
    const edited = read('.cursor/rules/align.md');

    expect(await undo()).toBe(1);
    expect(read('.cursor/rules/align.md')).toBe(edited);
    // The message names the OS-native path (backslashes on Windows), so compare separator-normalised.
    expect(errs.join('\n').replaceAll('\\', '/')).toContain('.cursor/rules/align.md');
    // everything else was still taken out
    expect(existsSync(path.join(repo, '.mcp.json'))).toBe(false);
    expect(existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(Object.keys(manifest).map((f) => path.relative(repo, f).replaceAll('\\', '/'))).toEqual(['.cursor/rules/align.md']);
  });

  it('c2. keeps a user\'s own hook in .claude/settings.json and takes only align\'s out', async () => {
    mkdirSync(path.join(repo, '.claude'));
    const original = `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`;
    writeFileSync(path.join(repo, '.claude/settings.json'), original);

    firstRun();
    expect(read('.claude/settings.json')).toContain('align check');
    expect(await undo()).toBe(0);
    expect(read('.claude/settings.json')).toBe(original);
  });

  it('d. a second undo says there is nothing to undo, truthfully', async () => {
    firstRun();
    expect(await undo()).toBe(0);
    out.length = 0;
    expect(await undo()).toBe(0);
    expect(out.join('\n')).toContain('Nothing to undo');
    expect(files()).toEqual([]);
  });

  it('e. does not claim there is nothing to undo while align\'s files are in the repo with no record', async () => {
    firstRun();
    manifest = {}; // written by a build that kept no record
    expect(await undo()).toBe(1);
    const all = [...out, ...errs].join('\n');
    expect(all).not.toContain('Nothing to undo');
    expect(all).toContain('.mcp.json');
    expect(all).toContain('CLAUDE.md');
    expect(read('.mcp.json')).toContain('align'); // nothing was touched
  });

  it('f. a re-run with another env does not strand the generated plugins', async () => {
    firstRun();
    setupAgentAlignment({ cwd: repo, env: 'staging' });
    expect(read('.pi/extensions/align.ts')).toContain('staging');
    expect(await undo()).toBe(0);
    expect(files()).toEqual([]);
  });

  it('g. a user file inside a directory align made keeps that directory', async () => {
    firstRun();
    writeFileSync(path.join(repo, '.cursor/mine.txt'), 'x');
    expect(await undo()).toBe(0);
    expect(read('.cursor/mine.txt')).toBe('x');
    expect(existsSync(path.join(repo, '.cursor/rules'))).toBe(false);
  });

  it('h. an unrelated ledger entry does not hide files align has no record of', async () => {
    firstRun();
    manifest = { [path.join(os.tmpdir(), 'elsewhere-not-there.json')]: { created: true, sha256: 'x', firstSha256: 'x', backup: 'none' } };
    expect(await undo()).toBe(1);
    expect(errs.join('\n')).toContain('.mcp.json');
    expect(read('.mcp.json')).toContain('align');
  });

  it('e2. still says nothing to undo in a repo align never wrote to', async () => {
    expect(await undo()).toBe(0);
    expect(out.join('\n')).toContain('Nothing to undo');
  });
});
