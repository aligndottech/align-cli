import { ZoomFetcher } from '@aligndottech/connector-core';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal Zoom import (canonical fetcher in connector-core). */
export async function fetchZoomItems(opts: { token: string; limit?: number; uuid?: string }): Promise<PersonalImportItem[]> {
  return new ZoomFetcher().fetch(opts);
}
