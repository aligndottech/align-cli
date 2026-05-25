import { buildCommitUrl, formatCommitAsText, getCommitHistory, getRemoteUrl } from '../git.js';
import type { PersonalImportItem } from '../personal-import.js';

export async function fetchGitItems(opts: { limit: number }): Promise<PersonalImportItem[]> {
  const commits = await getCommitHistory({ limit: opts.limit });
  const remoteUrl = await getRemoteUrl();
  return commits.map(c => {
    const url = buildCommitUrl(remoteUrl, c.sha);
    return {
      source_url: url,
      platform: 'git' as const,
      raw_text: formatCommitAsText(c, url),
      title: c.subject,
    };
  });
}
