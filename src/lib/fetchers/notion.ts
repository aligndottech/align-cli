import { NotionFetcher } from '@aligndottech/connector-core';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal Notion import (canonical fetcher in connector-core). */
export async function fetchNotionItems(opts: { token: string; limit?: number }): Promise<PersonalImportItem[]> {
  return new NotionFetcher().fetch(opts);
}
