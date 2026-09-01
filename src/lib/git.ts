import { execa } from 'execa';

export interface GitCommit {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  filesChanged: string[];
}

export interface CommitHistoryResult {
  commits: GitCommit[];
  /** Every commit `git log` returned, before either promotion filter ran - i.e. what
   *  `commits.length` is a fraction OF. Needed to report "fewer, better rows" honestly
   *  (ALI-804): `commits.length` alone reads as "this is everything", not as a kept count. */
  scanned: number;
}

/**
 * Same as {@link getCommitHistory}, plus the raw scanned count. A separate export
 * because {@link getCommitHistory}'s `Promise<GitCommit[]>` signature is the
 * `GitCommitSource` contract connector-core's `GitFetcher` is typed against
 * (`node_modules/@aligndottech/connector-core`) - changing its return shape would
 * break that interface for no gain, since the SDK fetcher never needs the scanned count.
 */
export async function getCommitHistoryDetailed(opts: {
  limit?: number;
  from?: string;
  to?: string;
  branch?: string;
  /** Run git in this directory instead of the process cwd. Lets tests point at a
   *  fixture repo without process.chdir, which leaks across concurrent workers. */
  cwd?: string;
}): Promise<CommitHistoryResult> {
  const SEP = '\x1f';
  const MARKER = `COMMIT${SEP}`;
  const BODY_END = `${SEP}END`;

  // --name-only fetches metadata + file list in one git invocation,
  // replacing the previous O(N) approach of one git show --stat per commit.
  //
  // ALI-792: %b (the body) is in the format now, and merges are no longer excluded.
  // The body is where the evidence lives - ticket refs, closes #N, thread links, and
  // on squash-merge repos the whole PR description - and it was previously discarded
  // (body was hard-coded ''). Porcelain-created commits end a non-empty %b with a
  // newline, so the SEP+END terminator usually lands on its own line - but commits
  // from plumbing (commit-tree), --cleanup=verbatim, or libgit2-based bots can lack
  // the trailing newline, putting a REAL body inline on the header line or leaving
  // the terminator as a suffix on the last body line. The parser handles all three
  // placements; assuming inline END meant "empty body" silently dropped exactly the
  // data this format change exists to capture (caught in review, 2026-09-01).
  //
  // Merges now consume -n limit slots (they were previously excluded pre-limit), so
  // on merge-heavy repos the same limit reaches less far back - accepted trade for
  // capturing PR descriptions.
  const args = [
    `--format=COMMIT${SEP}%H${SEP}%s${SEP}%aN${SEP}%aI${SEP}%b${SEP}END`,
    '--name-only',
    '-n', String(opts.limit ?? 500),
  ];
  if (opts.branch) args.push(opts.branch);
  if (opts.from) args.push(`--after=${opts.from}`);
  if (opts.to) args.push(`--before=${opts.to}`);

  let stdout: string;
  try {
    ({ stdout } = await execa('git', ['log', ...args], opts.cwd ? { cwd: opts.cwd } : {}));
  } catch (err) {
    // A freshly initialised repo with no commits makes `git log` exit 128
    // ("does not have any commits yet"). Return [] so `align import git` /
    // `align setup` degrade to "0 commits" instead of crashing on first run.
    // Other git failures (e.g. a bad --branch) still surface.
    const e = err as { exitCode?: number; stderr?: string };
    if (e.exitCode === 128 && /does not have any commits|bad default revision/i.test(e.stderr ?? '')) {
      return { commits: [], scanned: 0 };
    }
    throw err;
  }

  const commits: GitCommit[] = [];
  let scanned = 0;
  let sha = '', subject = '', author = '', date = '';
  let bodyLines: string[] = [];
  let files: string[] = [];
  let mode: 'idle' | 'body' | 'files' = 'idle';

  const flush = () => {
    if (mode === 'idle' || !sha) return;
    scanned++;
    const shaped = resolveCommitShape(subject, bodyLines.join('\n').trimEnd());
    // A promoted merge (ALI-792) already cleared an extra bar: its subject came from the
    // body's own first line via isDecisionCommit, and its body always retains the original
    // "Merge pull request #N from x/y" line for the PR ref - so it never needs to ALSO
    // clear the rationale bar below. A plain commit gets no such head start: its subject
    // is unvetted prose, so the body has to state why, or it is pure "what changed"
    // (ALI-804 - the whole complaint this filter exists to answer).
    const wasPromotedMerge = shaped.subject !== subject;
    if (isDecisionCommit(shaped.subject) && (wasPromotedMerge || hasStatedRationale(shaped.subject, shaped.body))) {
      commits.push({ sha, subject: shaped.subject, body: shaped.body, author, date, filesChanged: files.slice(0, 10) });
    }
  };

  // A header line must carry a full 40-hex sha in the second field. Without the check,
  // a commit BODY containing a line that starts with "COMMIT\x1f" (git preserves \x1f
  // in messages) would flush the real commit early and parse a forged record with
  // attacker-chosen sha/author/date - and that sha would be interpolated into a
  // source_url. Real `git log` headers always carry the full sha, so this refuses
  // nothing legitimate.
  const isHeader = (parts: string[]) => /^[0-9a-f]{40}$/.test(parts[1] ?? '');

  // \r?\n, not \n: a Windows git (or a \r\n-bearing message) leaves a trailing \r on
  // every line under a bare \n split, which silently breaks the exact-match END
  // comparisons below and pollutes bodies (Copilot review, PR #213).
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.startsWith(MARKER) ? line.split(SEP) : null;
    if (parts && isHeader(parts)) {
      flush();
      sha = parts[1] ?? '';
      subject = parts[2] ?? '';
      author = parts[3] ?? '';
      date = parts[4] ?? '';
      bodyLines = [];
      files = [];
      // Terminator inline on the header line covers BOTH an empty body and a
      // single-line body with no trailing newline: the body is whatever sits between
      // the date field and the END token (empty string for a truly empty body).
      if (parts[parts.length - 1] === 'END') {
        const inlineBody = parts.slice(5, -1).join(SEP);
        if (inlineBody) bodyLines.push(inlineBody);
        mode = 'files';
      } else {
        bodyLines.push(parts.slice(5).join(SEP));
        mode = 'body';
      }
    } else if (mode === 'body') {
      if (line === BODY_END) {
        mode = 'files';
      } else if (line.endsWith(BODY_END)) {
        // Last body line with no trailing newline: the terminator rides the line.
        bodyLines.push(line.slice(0, -BODY_END.length));
        mode = 'files';
      } else {
        bodyLines.push(line);
      }
    } else if (mode === 'files' && line.trim()) {
      files.push(line.trim());
    }
  }
  flush();

  return { commits, scanned };
}

export async function getCommitHistory(opts: Parameters<typeof getCommitHistoryDetailed>[0]): Promise<GitCommit[]> {
  return (await getCommitHistoryDetailed(opts)).commits;
}

/**
 * A merge commit's boilerplate subject hides the decision its body carries: on GitHub's
 * default merge flow the PR title and description live in the BODY ("Merge pull request
 * #78 from x/y" \n\n "Adopt token-bucket rate limiting..."). Promote the body's first
 * line to the subject when it would pass the decision filter on its own, and keep the
 * original merge subject in the body so the #N PR ref survives into the ingested text.
 * A merge whose body has nothing decision-shaped keeps its boilerplate subject and is
 * excluded by isDecisionCommit exactly as before.
 */
function resolveCommitShape(subject: string, body: string): { subject: string; body: string } {
  if (!/^merge\b/i.test(subject.trim())) return { subject, body };
  const lines = body.split('\n');
  const firstIdx = lines.findIndex(l => l.trim());
  const first = firstIdx === -1 ? '' : lines[firstIdx].trim();
  if (!isDecisionCommit(first)) return { subject, body };
  const rest = lines.slice(firstIdx + 1).join('\n').trim();
  return { subject: first, body: [subject, rest].filter(Boolean).join('\n') };
}

export function isDecisionCommit(subject: string): boolean {
  if (subject.length < 20) return false;
  return !/^(chore|wip|merge|revert|bump|update deps|release|typo)/i.test(subject.trim());
}

// A line that IS a git trailer (key: value at the start of the line), not merely a
// sentence that happens to mention one of these words mid-line - "Refs ALI-123 and
// closes #45." inside a real paragraph must NOT be stripped, only a line that is
// nothing but the trailer.
const TRAILER_LINE_RE = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|helped-by|cc|refs?|closes?|fixes?|resolves?)\s*:\s*\S/i;
// Attribution lines an agent appends (e.g. "🤖 Generated with [Claude Code](...)")
// carry no rationale either - it's who/what wrote the commit, not why.
const GENERATED_WITH_RE = /generated with/i;

function normalizeForEcho(s: string): string {
  return s.toLowerCase().replace(/^[*\-•]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does this commit's body actually state a reason, once the noise is stripped? Measured
 * while filtering ALI-804's git-only import: a body-shaped string is not automatically a
 * WHY - a git trailer inflates "has a body" with no rationale in it, and a squash-merge
 * bullet that just repeats the subject ("* fix: same as the subject") reads as prose
 * while adding none. This is the same "prose in body, non-mechanical subject" proxy the
 * ALI-804 measurement itself used to produce its headline numbers, made executable.
 */
export function hasStatedRationale(subject: string, body: string): boolean {
  if (!body.trim()) return false;
  const subjectNorm = normalizeForEcho(subject);
  const remaining = body
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !TRAILER_LINE_RE.test(l) && !GENERATED_WITH_RE.test(l))
    .filter(l => normalizeForEcho(l) !== subjectNorm);
  return remaining.length > 0;
}

export async function getRemoteUrl(): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function buildCommitUrl(remoteUrl: string | null, sha: string): string {
  if (!remoteUrl) return `git://commit/${sha}`;
  const sshGh = remoteUrl.match(/git@github\.com[:/](.+?)(?:\.git)?$/);
  if (sshGh) return `https://github.com/${sshGh[1]}/commit/${sha}`;
  const httpsGh = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (httpsGh) return `https://github.com/${httpsGh[1]}/commit/${sha}`;
  const gl = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
  if (gl) return `https://gitlab.com/${gl[1]}/-/commit/${sha}`;
  return `git://commit/${sha}`;
}

export function formatCommitAsText(commit: GitCommit, commitUrl?: string): string {
  const parts = [commit.subject];
  if (commit.body) parts.push(commit.body);
  parts.push(`Author: ${commit.author}`);
  parts.push(`Date: ${commit.date}`);
  if (commit.filesChanged.length) {
    parts.push(`Files changed:\n${commit.filesChanged.join('\n')}`);
  }
  if (commitUrl) parts.push(`URL: ${commitUrl}`);
  return parts.join('\n\n');
}

export async function getStagedDiff(): Promise<string> {
  const result = await execa('git', ['diff', '--staged']);
  return result.stdout;
}

export async function getHeadDiff(): Promise<string> {
  const result = await execa('git', ['diff', 'HEAD']);
  return result.stdout;
}

/**
 * Diff of this branch against where it diverged from `baseRef`.
 *
 * This is the shape CI needs. A CI checkout has a clean working tree, so `git diff --staged`
 * and `git diff HEAD` are both empty there - a pipeline relying on them checks nothing and
 * passes, which is worse than no gate at all.
 *
 * Three dots deliberately: `base...HEAD` diffs from the MERGE BASE, so it contains only the
 * commits on this branch. `base..HEAD` would also include everything that landed on the base
 * since the branch diverged, submitting other people's changes for analysis and letting a
 * conflict this branch did not cause fail it.
 */
export async function getBaseDiff(baseRef: string): Promise<string> {
  const result = await execa('git', ['diff', `${baseRef}...HEAD`]);
  return result.stdout;
}

export async function getCurrentBranch(): Promise<string> {
  const result = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

export async function isGitRepo(): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}
