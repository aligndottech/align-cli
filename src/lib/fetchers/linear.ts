import { LinearFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/** Read-only personal Linear import (canonical fetcher in connector-core). */
export async function fetchLinearItems(opts: { token: string; limit?: number }): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new LinearFetcher());
}
