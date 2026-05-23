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
  const args = [`--format=%H${SEP}%s${SEP}%aN${SEP}%aI`, '--no-merges', '-n', String(opts.limit ?? 100)];
  if (opts.branch) args.push(opts.branch);
  if (opts.from) args.push(`--after=${opts.from}`);
  if (opts.to) args.push(`--before=${opts.to}`);

  const { stdout } = await execa('git', ['log', ...args]);
  const lines = stdout.split('\n').filter(Boolean);

  const commits: GitCommit[] = [];
  for (const line of lines) {
    const [sha, subject, author, date] = line.split(SEP);
    if (!sha || !subject) continue;
    if (!isDecisionCommit(subject)) continue;

    const { stdout: stat } = await execa('git', ['show', '--stat', '--format=', sha]);
    const filesChanged = stat.split('\n')
      .filter(l => l.includes('|') || /^\s+\S+.*\|/.test(l))
      .map(l => l.trim().split('|')[0].trim())
      .filter(Boolean)
      .slice(0, 10);

    commits.push({ sha, subject, body: '', author: author ?? '', date: date ?? '', filesChanged });
  }
  return commits;
}

export function isDecisionCommit(subject: string): boolean {
  if (subject.length < 20) return false;
  return !/^(fix|chore|wip|merge|revert|bump|update deps|release|typo)/i.test(subject.trim());
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
