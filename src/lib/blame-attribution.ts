import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isHousekeepingTitle, isNonBehaviouralType } from './commit-shape.js';
import type { HookToolInput } from './hook-payload.js';

/**
 * The decisions that WROTE the lines an agent is about to change.
 *
 * Content search finds decisions on the same subject; it cannot say which decision put these
 * exact lines here. `git blame` can, deterministically and locally, so the advisory hook asks
 * it first. No AI call, no network. Everything here fails open to `null`: no repo, an
 * untracked or missing file, text not found, a blame error or a timeout all mean "no
 * attribution", and the hook carries on exactly as it did before.
 */
export interface LineWriters {
  /** Full SHAs of the commits that wrote the lines the edit replaces. */
  commitShas: string[];
  /** Lower-cased `https://github.com/<owner>/<repo>/pull/<n>` for squash-merged PRs. */
  prUrls: string[];
}

/** Inside the hook's 10s timeout and the 2.5s retrieval race it runs beside. */
export const BLAME_TIMEOUT_MS = 1500;
/** A rewrite of a huge file would blame thousands of lines for no extra signal. */
const MAX_BLAME_LINES = 400;
const MAX_OCCURRENCES = 3;

export type Range = [start: number, end: number];

const lineOf = (text: string, index: number): number => {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

/** 1-based line ranges in `current` covered by each occurrence of `needle`. */
function rangesOfText(current: string, needle: string): Range[] {
  const out: Range[] = [];
  const trimmed = needle.replace(/\n+$/, '');
  if (!trimmed) return out;
  const span = trimmed.split('\n').length - 1;
  for (let at = current.indexOf(trimmed); at !== -1 && out.length < MAX_OCCURRENCES; at = current.indexOf(trimmed, at + trimmed.length)) {
    const start = lineOf(current, at);
    out.push([start, start + span]);
  }
  return out;
}

/** For a Write: the lines of the current file the new content does not keep (common prefix and suffix trimmed). */
function rangesChangedBy(current: string, next: string): Range[] {
  const a = current.split('\n');
  const b = next.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const end = a.length - tail; // exclusive, 0-based
  return end > head ? [[head + 1, end]] : [];
}

function capped(ranges: Range[]): Range[] {
  let budget = MAX_BLAME_LINES;
  const out: Range[] = [];
  for (const [s, e] of ranges) {
    if (budget <= 0) break;
    const end = Math.min(e, s + budget - 1);
    out.push([s, end]);
    budget -= end - s + 1;
  }
  return out;
}

/** owner/repo from a GitHub remote url (https or ssh), lower-cased; null for anything else. */
export function githubRepoOf(remote: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const prNumberOf = (subject: string): string | null =>
  /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? null;

const PROSE_EXTENSION = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
// LICENSE, LICENCE, CHANGELOG, CHANGES, AUTHORS, CONTRIBUTORS, NOTICE and their variants (LICENSE-MIT, LICENSE-APACHE-2.0).
const PROSE_BASENAME = /^(?:licen[sc]e|changelog|changes|authors|contributors|notice)/i;
// A real extension starts with a letter: ".js" is one, the ".0" of "LICENSE-APACHE-2.0" is not.
const CODE_EXTENSION = /\.[a-z][a-z0-9]*$/i;
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum']);

/**
 * Files whose lines carry no decision an edit could violate: prose documents, licence and changelog
 * style files, and generated lockfiles. On a repo whose history is not conventional-commit typed, a
 * prose edit would otherwise be pinned on whatever untyped commit last touched the line. Checked before
 * any git call, so these edits cost nothing and keep the content-search related list as it was.
 * Its complement is everything else, still blamed: source, .json/.yaml/.toml config, .sql, Dockerfiles,
 * extensionless scripts, and a code file that merely starts like a licence ("LICENSE-tool.js").
 */
export function isProseOrGeneratedFile(file: string): boolean {
  const base = path.basename(file);
  const lower = base.toLowerCase();
  if (PROSE_EXTENSION.test(base) || LOCKFILES.has(lower) || lower.endsWith('.lock')) return true;
  return PROSE_BASENAME.test(base) && !CODE_EXTENSION.test(base);
}

export interface BlameOpts {
  timeoutMs?: number;
  /** Test seam: runs one git command. Defaults to the real git; the budget is enforced around it either way. */
  runGit?: (args: string[], cwd: string, timeoutMs: number) => Promise<{ stdout: string }>;
}

export type GitRun = (args: string[]) => Promise<{ stdout: string }>;

/** One git runner whose budget holds for any underlying runner, not only execa's own kill. */
export function makeGitRunner(opts: BlameOpts, cwd: string): GitRun {
  const timeout = opts.timeoutMs ?? BLAME_TIMEOUT_MS;
  const runGit = opts.runGit ?? ((args, dir, ms) => execa('git', args, { cwd: dir, timeout: ms, reject: true, stdin: 'ignore' }));
  return (args) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('blame budget exceeded')), timeout); });
    return Promise.race([runGit(args, cwd, timeout), expired]).finally(() => clearTimeout(timer));
  };
}

export interface BlamedCommit {
  sha: string;
  subject: string;
  /** Committer time, epoch seconds (0 when git did not say). */
  time: number;
}

/** `git blame -w -M --porcelain` over the given 1-based line ranges; commits in first-seen order, uncommitted lines dropped. */
export async function blameCommits(file: string, ranges: Range[], run: GitRun): Promise<BlamedCommit[]> {
  const blame = await run(['blame', '-w', '-M', '--porcelain', ...ranges.flatMap(([s, e]) => ['-L', `${s},${e}`]), '--', path.basename(file)]);
  const commits = new Map<string, BlamedCommit>();
  let current: BlamedCommit | null = null;
  for (const line of blame.stdout.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (head) {
      current = /^0+$/.test(head[1]) ? null : (commits.get(head[1]) ?? { sha: head[1], subject: '', time: 0 });
      if (current) commits.set(current.sha, current);
    } else if (current && line.startsWith('summary ')) {
      current.subject = line.slice('summary '.length);
    } else if (current && line.startsWith('committer-time ')) {
      current.time = Number(line.slice('committer-time '.length)) || 0;
    }
  }
  return [...commits.values()];
}

/** PR urls for squash-merged commits, from "(#N)" / "Merge pull request #N" subjects and the origin remote. No origin only costs the mapping. */
export async function prUrlsFor(commits: BlamedCommit[], run: GitRun): Promise<string[]> {
  const prNumbers = new Set(commits.flatMap((c) => prNumberOf(c.subject) ?? []));
  if (!prNumbers.size) return [];
  const repo = githubRepoOf(await run(['remote', 'get-url', 'origin']).then((r) => r.stdout, () => ''));
  return repo ? [...prNumbers].map((n) => `https://github.com/${repo}/pull/${n}`) : [];
}

export async function findLineWriters(
  input: HookToolInput | undefined,
  cwd: string,
  opts: BlameOpts = {},
): Promise<LineWriters | null> {
  try {
    if (!input || typeof input.file_path !== 'string' || !input.file_path) return null;
    if (isProseOrGeneratedFile(input.file_path)) return null;
    const file = path.resolve(cwd, input.file_path);
    const current = await readFile(file, 'utf8');

    let ranges: Range[] = [];
    if (typeof input.content === 'string') {
      ranges = rangesChangedBy(current, input.content);
    } else {
      const olds = Array.isArray(input.edits) ? input.edits.map((e) => e.old_string) : [input.old_string];
      for (const old of olds) if (typeof old === 'string') ranges.push(...rangesOfText(current, old));
    }
    ranges = capped(ranges);
    if (!ranges.length) return null;

    const run = makeGitRunner(opts, path.dirname(file));
    const commits = await blameCommits(file, ranges, run);
    if (!commits.length) return null;
    return { commitShas: commits.map((c) => c.sha), prUrls: await prUrlsFor(commits, run) };
  } catch {
    return null;
  }
}

/**
 * Whether a decision may be shown as "the decision that wrote these lines". Routine conventional-commit
 * types (docs, style, test, chore, ci, build, release) decide nothing an edit could violate, and a
 * refactor rewrites lines without deciding what they do, so naming it would hide the real writer.
 * Naming any of them would fire on most routine edits and teach people to ignore the hook. They stay
 * eligible for the content-search related list. fix, feat, perf and untyped titles qualify.
 * The shapes come from commit-shape.ts (non-behavioural types, plus the housekeeping shapes: merges,
 * drafts, backports, version bumps), so there is one list of what a mechanical subject looks like.
 */
export function isWriterTitle(title: string): boolean {
  return !isNonBehaviouralType(title) && !isHousekeepingTitle(title);
}
