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

  // --name-only fetches metadata + file list in one git invocation,
  // replacing the previous O(N) approach of one git show --stat per commit.
  const args = [
    `--format=COMMIT${SEP}%H${SEP}%s${SEP}%aN${SEP}%aI`,
    '--no-merges',
    '--name-only',
    '-n', String(opts.limit ?? 500),
  ];
  if (opts.branch) args.push(opts.branch);
  if (opts.from) args.push(`--after=${opts.from}`);
  if (opts.to) args.push(`--before=${opts.to}`);

  const { stdout } = await execa('git', ['log', ...args]);

  const commits: GitCommit[] = [];
  let sha = '', subject = '', author = '', date = '';
  let files: string[] = [];
  let active = false;

  const flush = () => {
    if (active && sha && isDecisionCommit(subject)) {
      commits.push({ sha, subject, body: '', author, date, filesChanged: files.slice(0, 10) });
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
      files = [];
      active = true;
    } else if (active && line.trim()) {
      files.push(line.trim());
    }
  }
  flush();

  return commits;
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
