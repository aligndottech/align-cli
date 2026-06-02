import { GitHubFetcher } from '@aligndottech/connector-core';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal GitHub import (canonical fetcher in connector-core). */
export async function fetchGitHubItems(opts: { token: string; limit?: number }): Promise<PersonalImportItem[]> {
  return new GitHubFetcher().fetch(opts);
}
