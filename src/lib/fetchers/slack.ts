import { SlackFetcher } from '@aligndottech/connector-core';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal Slack import (canonical fetcher in connector-core). */
export async function fetchSlackItems(opts: { token: string; limit?: number; daysBack?: number }): Promise<PersonalImportItem[]> {
  return new SlackFetcher().fetch(opts);
}
