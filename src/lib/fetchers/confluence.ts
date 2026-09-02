import { ConfluenceFetcher, FetcherAuthError } from '@aligndottech/connector-core';
import { AuthExpiredError } from '../errors.js';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/** Read-only personal Confluence import. Delegates to the canonical fetcher in
 *  @aligndottech/connector-core; maps its auth error to the CLI's reconnect flow. */
export async function fetchConfluenceItems(opts: {
  token: string;
  cloudId?: string;
  siteBase?: string;
  email?: string;
  domain?: string;
  limit?: number;
}): Promise<CaptureFetchResult> {
  try {
    return await withCaptureReport(opts, () => new ConfluenceFetcher().fetch(opts));
  } catch (e) {
    if (e instanceof FetcherAuthError) throw new AuthExpiredError(e.connector);
    throw e;
  }
}
