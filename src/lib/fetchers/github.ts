import { GitHubFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/** Read-only personal GitHub import (canonical fetcher in connector-core). */
export async function fetchGitHubItems(opts: { token: string; limit?: number }): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new GitHubFetcher());
}
