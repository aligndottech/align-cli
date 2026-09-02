import { SlackFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/** Read-only personal Slack import (canonical fetcher in connector-core). */
export async function fetchSlackItems(opts: { token: string; limit?: number; daysBack?: number }): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, () => new SlackFetcher().fetch(opts));
}
