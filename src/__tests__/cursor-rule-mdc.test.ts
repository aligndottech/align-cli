import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUse, type UseDeps } from '../commands/use.js';
import { planAgentAlignment, projectFilesWithAlignText, setupAgentAlignment, writeCursorRule } from '../lib/agent-rules.js';
import { mergeWrittenConfig, safeWriteText, setWriteRecorder, type WrittenConfig } from '../lib/safe-config-write.js';

/*
 * Cursor loads only `.mdc` files from .cursor/rules, so align's rule must be `align.mdc`.
 * All paths are temp dirs; the recorder is a local manifest, so nothing touches the real HOME.
 *
 * Test list:
 *  1. fresh setup writes align.mdc with the rule body and no align.md
 *     a. direct writeCursorRule   b. through setupAgentAlignment for the cursor agent
 *  2. re-running is idempotent
 *     a. content unchanged after a second writeCursorRule   b. one rules entry after two full setups
 *  3. migration from an older install's align.md
 *     a. recorded, created by align, unedited: removed, mdc written
 *     b. edited after align wrote it: kept, one line says so, mdc written
 *     c. no record of writing it: kept, one line says so, mdc written
 *     d. a user's own pre-existing align.md that a record shows align did not create: kept
 *  3e. the new write refused (symlinked rules dir): the recorded legacy file behind the link survives
 *  3f. same with a symlinked .cursor
 *  3g. an align.md with an unrelated body is never named; 3h. a second unrelated body, still silent
 *  3i. an edited align-written file is named (3b); 3j. an unrecorded align-headed file is named (3c)
 *  4. undo
 *     a. align.mdc created by align and unedited: deleted, tree back to before
 *     b. align.mdc edited by the user: left alone and named
 *     c. a legacy recorded align.md is still removed by undo
 *     d. a legacy align.md with no record is named, not touched
 *  5. every listing names .mdc
 *     a. the plan for cursor lists align.mdc and not align.md
 *     b. the "carries align text" detector finds align.mdc
 *     c. no src file writes .cursor/rules/align.md except the legacy-cleanup constant
 */
let repo: string;
let manifest: Record<string, WrittenConfig>;
let out: string[];
let errs: string[];
let noted: string[];

const MDC = '.cursor/rules/align.mdc';
const LEGACY = '.cursor/rules/align.md';
const abs = (f: string) => path.join(repo, f);
const read = (f: string) => readFileSync(abs(f), 'utf8');
const ruleFiles = () => readdirSync(abs('.cursor/rules')).sort();
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });

// What an older build did: write align.md through the safe writer, which records it.
function writeLegacy(content = '# Align decision graph\nold rule\n') {
  safeWriteText(abs(LEGACY), () => content, { root: repo, projectFile: true, trailingNewline: true });
}

function deps(): UseDeps {
  return {
    config: { getAgent: () => undefined, setAgent: () => {}, clearAgent: () => {}, setLaunchOff: () => {}, clearRefusedWrites: () => {} },
    findOnPath: () => null,
    writtenConfigs: { get: () => manifest, drop: (fs) => { for (const f of fs) delete manifest[f]; } },
    env: {},
    platform: process.platform,
    cwd: repo,
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
  };
}
const undo = () => runUse(undefined, deps(), { undo: true });

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'align-mdc-'));
  manifest = {};
  out = [];
  errs = [];
  noted = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { noted.push(a.join(' ')); });
  setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
  git('init', '-q');
});
afterEach(() => {
  setWriteRecorder(undefined);
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('1. fresh setup writes align.mdc', () => {
  it('a. writeCursorRule writes align.mdc with always-apply frontmatter and no align.md', () => {
    expect(writeCursorRule(repo)).toBe(true);
    expect(ruleFiles()).toEqual(['align.mdc']);
    expect(read(MDC)).toMatch(/^---\n[\s\S]*alwaysApply: true[\s\S]*---\n/);
    expect(read(MDC)).toContain('Align decision graph');
  });

  it('b. setup for the cursor agent writes align.mdc and no align.md', () => {
    const written = setupAgentAlignment({ cwd: repo, agent: 'cursor' });
    expect(written).toContain(MDC);
    expect(written).not.toContain(LEGACY);
    expect(existsSync(abs(LEGACY))).toBe(false);
    expect(ruleFiles()).toEqual(['align.mdc']);
  });
});

describe('2. re-running is idempotent', () => {
  it('a. a second writeCursorRule leaves the content identical', () => {
    writeCursorRule(repo);
    const first = read(MDC);
    expect(writeCursorRule(repo)).toBe(true);
    expect(read(MDC)).toBe(first);
  });

  it('b. two full setups leave exactly one rules entry', () => {
    setupAgentAlignment({ cwd: repo, agent: 'cursor' });
    setupAgentAlignment({ cwd: repo, agent: 'cursor' });
    expect(ruleFiles()).toEqual(['align.mdc']);
  });
});

describe('3. migration from an older align.md', () => {
  it('a. removes a recorded, unedited align.md and writes align.mdc', () => {
    writeLegacy();
    expect(writeCursorRule(repo)).toBe(true);
    expect(ruleFiles()).toEqual(['align.mdc']);
    expect(noted).toEqual([]);
  });

  it('b. keeps an align.md the user edited after align wrote it, says so once, writes align.mdc', () => {
    writeLegacy();
    writeFileSync(abs(LEGACY), `${read(LEGACY)}my own line\n`);
    expect(writeCursorRule(repo)).toBe(true);
    expect(ruleFiles()).toEqual(['align.md', 'align.mdc']);
    expect(read(LEGACY)).toContain('my own line');
    expect(noted.filter((n) => n.includes(LEGACY))).toHaveLength(1);
    expect(noted.join('\n')).toContain('edited');
  });

  it('c. keeps an align.md align has no record of writing, says so once, writes align.mdc', () => {
    mkdirSync(abs('.cursor/rules'), { recursive: true });
    writeFileSync(abs(LEGACY), '# Align decision graph\nwritten by a build that kept no record\n');
    expect(writeCursorRule(repo)).toBe(true);
    expect(ruleFiles()).toEqual(['align.md', 'align.mdc']);
    expect(noted.filter((n) => n.includes(LEGACY))).toHaveLength(1);
    expect(noted.join('\n')).toContain('align has no record of writing it');
  });

  it('d. keeps a pre-existing align.md that the record says align did not create', () => {
    mkdirSync(abs('.cursor/rules'), { recursive: true });
    writeFileSync(abs(LEGACY), 'the user had this file first\n');
    writeLegacy('# Align decision graph\nalign overwrote the user file\n'); // align rewrote a file it did not create
    expect(manifest[abs(LEGACY)]?.created).toBe(false);
    expect(writeCursorRule(repo)).toBe(true);
    expect(read(LEGACY)).toContain('align overwrote the user file');
    expect(noted.filter((n) => n.includes(LEGACY))).toHaveLength(1);
  });
});

describe('3e-3h. refusal and noise', () => {
  // The ledger keeps the repo-relative path, so the legacy file is written first and then moved behind a link.
  function linkAway(rel: string): string {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'align-mdc-other-'));
    renameSync(abs(rel), path.join(elsewhere, 'moved'));
    symlinkSync(path.join(elsewhere, 'moved'), abs(rel));
    return elsewhere;
  }

  it('e. a symlinked rules dir refuses the new write and keeps the legacy file behind the link', () => {
    writeLegacy();
    const elsewhere = linkAway('.cursor/rules');
    try {
      expect(writeCursorRule(repo)).toBe(false);
      expect(readdirSync(path.join(elsewhere, 'moved'))).toEqual(['align.md']);
      expect(noted.join('\n')).toContain('symlink');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('f. a symlinked .cursor refuses the new write and keeps the legacy file behind the link', () => {
    writeLegacy();
    const elsewhere = linkAway('.cursor');
    try {
      expect(writeCursorRule(repo)).toBe(false);
      expect(readdirSync(path.join(elsewhere, 'moved', 'rules'))).toEqual(['align.md']);
      expect(noted.join('\n')).toContain('symlink');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('g. an align.md with an unrelated body is kept and not named', () => {
    mkdirSync(abs('.cursor/rules'), { recursive: true });
    writeFileSync(abs(LEGACY), '# Team style notes\nuse tabs\n');
    expect(writeCursorRule(repo)).toBe(true);
    expect(read(LEGACY)).toContain('use tabs');
    expect(noted.filter((n) => n.includes(LEGACY))).toEqual([]);
  });

  it('h. a recorded align.md the user fully rewrote to something unrelated is kept and not named', () => {
    writeLegacy();
    writeFileSync(abs(LEGACY), 'entirely my own rule\n');
    expect(writeCursorRule(repo)).toBe(true);
    expect(read(LEGACY)).toBe('entirely my own rule\n');
    expect(noted.filter((n) => n.includes(LEGACY))).toEqual([]);
  });
});

describe('4. undo', () => {
  it('a. deletes an align.mdc align created and nobody edited, leaving the tree as before', async () => {
    writeFileSync(abs('README.md'), 'x');
    git('add', '-A');
    git('commit', '-qm', 'init');
    writeCursorRule(repo);
    expect(await undo()).toBe(0);
    expect(existsSync(abs(MDC))).toBe(false);
    expect(existsSync(abs('.cursor'))).toBe(false);
    expect(out.join('\n').replaceAll('\\', '/')).toContain(`Removed ${abs(MDC).replaceAll('\\', '/')}`);
  });

  it('b. leaves an edited align.mdc and names it', async () => {
    writeCursorRule(repo);
    writeFileSync(abs(MDC), `${read(MDC)}mine\n`);
    expect(await undo()).toBe(1);
    expect(read(MDC)).toContain('mine');
    expect(errs.join('\n').replaceAll('\\', '/')).toContain(MDC);
  });

  it('c. still removes a recorded legacy align.md', async () => {
    writeLegacy();
    expect(await undo()).toBe(0);
    expect(existsSync(abs(LEGACY))).toBe(false);
  });

  it('d. names a legacy align.md with no record and does not touch it', async () => {
    mkdirSync(abs('.cursor/rules'), { recursive: true });
    writeFileSync(abs(LEGACY), '# Align decision graph\nno record\n');
    expect(await undo()).toBe(1);
    expect(existsSync(abs(LEGACY))).toBe(true);
    expect(errs.join('\n').replaceAll('\\', '/')).toContain(LEGACY);
  });
});

describe('5. every listing names .mdc', () => {
  it('a. the plan for cursor lists align.mdc and not align.md', () => {
    const files = planAgentAlignment(repo, 'cursor').map((p) => p.file);
    expect(files).toContain(MDC);
    expect(files).not.toContain(LEGACY);
    expect(planAgentAlignment(repo).map((p) => p.file)).toContain(MDC);
  });

  it('b. the carries-align-text detector finds align.mdc', () => {
    writeCursorRule(repo);
    expect(projectFilesWithAlignText(repo)).toContain(MDC);
  });

  it('c. no source file names .cursor/rules/align.md outside the legacy constant', () => {
    const srcDir = path.resolve(__dirname, '..');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    const files = walk(srcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(20); // the walk found the sources
    expect(files.some((f) => readFileSync(f, 'utf8').includes('align.mdc'))).toBe(true); // control: the search can match
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => /rules\/align\.md['"`]/.test(l)).map((l) => `${path.relative(srcDir, f)}: ${l.trim()}`));
    expect(hits.filter((h) => !h.includes('LEGACY_CURSOR_RULE'))).toEqual([]);
  });
});
