import { GitFetcher } from '@aligndottech/connector-core';
import { getCommitHistory, getRemoteUrl } from '../git.js';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only local-git import. The canonical GitFetcher in connector-core is
 *  pure; the CLI injects the actual git I/O (log/remote) here. */
export async function fetchGitItems(opts: { limit: number }): Promise<PersonalImportItem[]> {
  return new GitFetcher({ getCommitHistory, getRemoteUrl }).fetch({ token: '', limit: opts.limit });
}
