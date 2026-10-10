import { NotionFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, type WindowedOpts, withCaptureReport } from './capture.js';

/** Read-only personal Notion import (canonical fetcher in connector-core). */
export async function fetchNotionItems(opts: { token: string; limit?: number } & WindowedOpts): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new NotionFetcher());
}
