import { TeamsFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/** Read-only personal Teams import (canonical fetcher in connector-core). */
export async function fetchTeamsItems(opts: { token: string; limit?: number }): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, () => new TeamsFetcher().fetch(opts));
}
