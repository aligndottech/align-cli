import { GitLabFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, type WindowedOpts, withCaptureReport } from './capture.js';

/** Read-only personal GitLab import (canonical fetcher in connector-core). */
export async function fetchGitLabItems(opts: { token: string; domain?: string; limit?: number } & WindowedOpts): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new GitLabFetcher());
}
