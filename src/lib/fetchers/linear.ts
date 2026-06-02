import { LinearFetcher } from '@aligndottech/connector-core';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal Linear import (canonical fetcher in connector-core). */
export async function fetchLinearItems(opts: { token: string; limit?: number }): Promise<PersonalImportItem[]> {
  return new LinearFetcher().fetch(opts);
}
