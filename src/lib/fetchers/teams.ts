import { TeamsFetcher } from '@aligndottech/connector-core';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal Teams import (canonical fetcher in connector-core). */
export async function fetchTeamsItems(opts: { token: string; limit?: number }): Promise<PersonalImportItem[]> {
  return new TeamsFetcher().fetch(opts);
}
