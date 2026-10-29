import { execa } from 'execa';
import { githubRepoOf, isProseOrGeneratedFile } from './blame-attribution.js';

/**
 * Code still built on a replaced decision.
 *
 * For each `supersedes` link (new replaces old) take the OLD decision's source, find the commit it
 * names, list the files that commit touched, and `git blame` those files on the default branch. A line
 * whose blame is still that commit has not been rewritten since the decision it came from was replaced.
 * That is a fact about history, not a verdict: the line may be fine. Everything is local git, no model.
 */
export interface StaleLink {
  oldId: string;
  oldTitle: string;
  oldSourceUrl: string | null;
  newId: string;
  newTitle: string;
  newSourceUrl: string | null;
  confidence: number;
  /** A person confirmed the link. False means a classifier wrote it. */
  humanConfirmed: boolean;
}

export interface StaleOptions {
  cwd: string;
  /** Also use links a classifier wrote and no person confirmed. Default false. */
  includeAi?: boolean;
  /** Most files blamed for one old decision. */
  maxFilesPerDecision?: number;
  /** Wall-clock budget for the whole run. */
  budgetMs?: number;
}

export type LineRange = [start: number, end: number];

export interface StaleFileHit { file: string; lines: number; ranges: LineRange[] }

export interface StaleFinding {
  replaced: { id: string; title: string; sourceUrl: string | null };
  replacedBy: { id: string; title: string; sourceUrl: string | null };
  commit: string;
  confirmation: 'confirmed' | 'ai-suggested';
  /** Present for an AI-suggested link, so the reader can weigh it. */
  confidence?: number;
  files: StaleFileHit[];
  totalLines: number;
}

export interface StaleSkip { decisionId: string; title: string; reason: string }

export interface StaleReport {
  findings: StaleFinding[];
  skipped: StaleSkip[];
  /** Per-decision file cap hits: old decisions with more touched files than the cap. */
  filesCapped: number;
  budgetExceeded: boolean;
  linksConsidered: number;
  /** AI-suggested links left out because --include-ai was not set. */
  aiExcluded: number;
  ref: string;
}

export class StaleError extends Error {}

export const DEFAULT_MAX_FILES = 40;
export const DEFAULT_BUDGET_MS = 90_000;
const GIT_TIMEOUT_MS = 30_000;

type Git = (args: string[]) => Promise<string>;

function gitIn(cwd: string): Git {
  return async (args) => (await execa('git', args, { cwd, timeout: GIT_TIMEOUT_MS, stdin: 'ignore', maxBuffer: 256 * 1024 * 1024 })).stdout;
}

const ok = (git: Git, args: string[]): Promise<boolean> => git(args).then(() => true, () => false);

/** The branch decisions land on: origin/HEAD, else main, else master, else the checked-out HEAD. */
export async function defaultRef(git: Git): Promise<string> {
  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  if (head.trim() && await ok(git, ['rev-parse', '--verify', '-q', head.trim()])) return head.trim();
  for (const name of ['main', 'master']) if (await ok(git, ['rev-parse', '--verify', '-q', name])) return name;
  return 'HEAD';
}

type Source = { kind: 'commit'; sha: string; repo: string } | { kind: 'pr'; number: string; repo: string };

export function parseSource(url: string | null): Source | null {
  if (!url) return null;
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(commit|pull)\/([0-9a-f]+|\d+)(?:[/?#].*)?$/i.exec(url.trim());
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  if (m[3] === 'commit' && /^[0-9a-f]{7,40}$/i.test(m[4])) return { kind: 'commit', sha: m[4].toLowerCase(), repo };
  if (m[3] === 'pull' && /^\d+$/.test(m[4])) return { kind: 'pr', number: m[4], repo };
  return null;
}

async function blameRanges(git: Git, ref: string, file: string, sha: string): Promise<LineRange[]> {
  const out = await git(['blame', '-w', '-M', '--line-porcelain', ref, '--', file]);
  const lines: number[] = [];
  for (const row of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (m && m[1] === sha) lines.push(Number(m[2]));
  }
  const ranges: LineRange[] = [];
  for (const n of lines) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === n - 1) last[1] = n; else ranges.push([n, n]);
  }
  return ranges;
}

export async function findStaleCode(links: StaleLink[], opts: StaleOptions): Promise<StaleReport> {
  const git = gitIn(opts.cwd);
  if (!await ok(git, ['rev-parse', '--git-dir'])) throw new StaleError('This is not a git repository. Run align stale inside the repository to check.');
  if ((await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    throw new StaleError('This is a shallow clone, so the commits that wrote the old code are missing and every result would read as "nothing found". Run `git fetch --unshallow` and try again.');
  }
  const ref = await defaultRef(git);
  const origin = githubRepoOf(await git(['remote', 'get-url', 'origin']).catch(() => ''));
  const maxFiles = opts.maxFilesPerDecision ?? DEFAULT_MAX_FILES;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);

  const usable = opts.includeAi ? links : links.filter((l) => l.humanConfirmed);
  const report: StaleReport = {
    findings: [], skipped: [], filesCapped: 0, budgetExceeded: false,
    linksConsidered: usable.length, aiExcluded: links.length - usable.length, ref,
  };
  const hitsBySha = new Map<string, StaleFileHit[]>();

  for (const link of usable) {
    const skip = (reason: string) => report.skipped.push({ decisionId: link.oldId, title: link.oldTitle, reason });
    if (Date.now() > deadline) { report.budgetExceeded = true; skip('time budget used up before this decision'); continue; }
    const src = parseSource(link.oldSourceUrl);
    if (!src) { skip('its source is not a GitHub commit or pull request link'); continue; }
    if (origin && src.repo !== origin) { skip(`its source is in ${src.repo}, not this repository`); continue; }

    let sha: string | null = null;
    if (src.kind === 'commit') {
      sha = (await git(['rev-parse', '--verify', '-q', `${src.sha}^{commit}`]).catch(() => '')).trim() || null;
      if (!sha) { skip('its commit is not in this clone'); continue; }
    } else {
      sha = (await git(['log', ref, '-F', '--grep', `(#${src.number})`, '-1', '--format=%H']).catch(() => '')).trim() || null;
      if (!sha) { skip(`no commit on ${ref} mentions (#${src.number})`); continue; }
    }

    let hits = hitsBySha.get(sha);
    if (!hits) {
      const touched = (await git(['show', '--name-only', '--format=', sha])).split('\n').filter((f) => f && !isProseOrGeneratedFile(f));
      if (touched.length > maxFiles) report.filesCapped++;
      hits = [];
      for (const file of touched.slice(0, maxFiles)) {
        if (Date.now() > deadline) { report.budgetExceeded = true; break; }
        // A file the commit touched may be gone or renamed on the default branch: nothing left to blame there.
        const ranges = await blameRanges(git, ref, file, sha).catch(() => []);
        const lines = ranges.reduce((n, [s, e]) => n + (e - s + 1), 0);
        if (lines > 0) hits.push({ file, lines, ranges });
      }
      hitsBySha.set(sha, hits);
    }
    if (!hits.length) continue;
    report.findings.push({
      replaced: { id: link.oldId, title: link.oldTitle, sourceUrl: link.oldSourceUrl },
      replacedBy: { id: link.newId, title: link.newTitle, sourceUrl: link.newSourceUrl },
      commit: sha,
      confirmation: link.humanConfirmed ? 'confirmed' : 'ai-suggested',
      ...(link.humanConfirmed ? {} : { confidence: link.confidence }),
      files: hits,
      totalLines: hits.reduce((n, h) => n + h.lines, 0),
    });
  }
  report.findings.sort((a, b) => b.totalLines - a.totalLines);
  return report;
}
