import { GitLabFetcher } from '@aligndottech/connector-core';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal GitLab import (canonical fetcher in connector-core). */
export async function fetchGitLabItems(opts: { token: string; domain?: string; limit?: number }): Promise<PersonalImportItem[]> {
  return new GitLabFetcher().fetch(opts);
}
