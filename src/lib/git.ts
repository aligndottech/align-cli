import { execa } from 'execa';

export interface GitCommit {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  filesChanged: string[];
}

export async function getCommitHistory(opts: {
  limit?: number;
  from?: string;
  to?: string;
  branch?: string;
}): Promise<GitCommit[]> {
  const SEP = '\x1f';
  const MARKER = `COMMIT${SEP}`;
  const BODY_END = `${SEP}END`;

  // --name-only fetches metadata + file list in one git invocation,
  // replacing the previous O(N) approach of one git show --stat per commit.
  //
  // ALI-792: %b (the body) is in the format now, and merges are no longer excluded.
  // The body is where the evidence lives - ticket refs, closes #N, thread links, and
  // on squash-merge repos the whole PR description - and it was previously discarded
  // (body was hard-coded ''). A non-empty %b always ends with a newline, so the
  // SEP+END terminator lands on its own line; an empty %b puts it inline on the
  // header line. Measured against real git output, 2026-09-01, not inferred.
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
    ({ stdout } = await execa('git', ['log', ...args]));
  } catch (err) {
    // A freshly initialised repo with no commits makes `git log` exit 128
    // ("does not have any commits yet"). Return [] so `align import git` /
    // `align setup` degrade to "0 commits" instead of crashing on first run.
    // Other git failures (e.g. a bad --branch) still surface.
    const e = err as { exitCode?: number; stderr?: string };
    if (e.exitCode === 128 && /does not have any commits|bad default revision/i.test(e.stderr ?? '')) {
      return [];
    }
    throw err;
  }

  const commits: GitCommit[] = [];
  let sha = '', subject = '', author = '', date = '';
  let bodyLines: string[] = [];
  let files: string[] = [];
  let mode: 'idle' | 'body' | 'files' = 'idle';

  const flush = () => {
    if (mode === 'idle' || !sha) return;
    const shaped = resolveCommitShape(subject, bodyLines.join('\n').trimEnd());
    if (isDecisionCommit(shaped.subject)) {
      commits.push({ sha, subject: shaped.subject, body: shaped.body, author, date, filesChanged: files.slice(0, 10) });
    }
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith(MARKER)) {
      flush();
      const parts = line.split(SEP);
      sha = parts[1] ?? '';
      subject = parts[2] ?? '';
      author = parts[3] ?? '';
      date = parts[4] ?? '';
      bodyLines = [];
      files = [];
      // An empty body renders SEP+END inline on the header line (parts: [..., '', 'END']);
      // a non-empty body continues on following lines until the terminator line.
      if (parts[parts.length - 1] === 'END') {
        mode = 'files';
      } else {
        bodyLines.push(parts.slice(5).join(SEP));
        mode = 'body';
      }
    } else if (mode === 'body') {
      if (line === BODY_END) {
        mode = 'files';
      } else {
        bodyLines.push(line);
      }
    } else if (mode === 'files' && line.trim()) {
      files.push(line.trim());
    }
  }
  flush();

  return commits;
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
