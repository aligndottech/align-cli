import { ZoomFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/** Read-only personal Zoom import (canonical fetcher in connector-core). */
export async function fetchZoomItems(opts: { token: string; limit?: number; uuid?: string }): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new ZoomFetcher());
}
