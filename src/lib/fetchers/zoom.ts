import { ZoomFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, type WindowedOpts, withCaptureReport } from './capture.js';

/** Read-only personal Zoom import (canonical fetcher in connector-core). */
export async function fetchZoomItems(opts: { token: string; limit?: number; uuid?: string } & WindowedOpts): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new ZoomFetcher());
}
