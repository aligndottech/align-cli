import { LinearFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/**
 * ALI-786: Linear's scoped personal-API-key dialog
 * (linear.app/settings/account/security/api-keys/new) lets a key be created without Read
 * access. This fetcher's query is read-only, so a key like that gets refused with a plain
 * 400 - `connector-core`'s providerError already surfaces Linear's own words for a 400 (see
 * fetchers/errors.js: a token hint is added only on 401, never 400), but "Argument
 * Validation Error" alone does not point a user at the fix. A 400 can also mean something
 * else (a malformed request, the complexity limit), so the hint is phrased as a
 * possibility, not a diagnosis - the wrapper cannot tell which one happened from the status
 * code alone.
 */
const LINEAR_400_HINT =
  'If this key was created at linear.app/settings/account/security/api-keys/new with limited ' +
  'permissions, it needs "Read" access - this import only reads your issues, never writes. ' +
  'Create a new key with Read included, or use an unscoped (classic) personal API key.';

/** Read-only personal Linear import (canonical fetcher in connector-core). */
export async function fetchLinearItems(opts: { token: string; limit?: number }): Promise<CaptureFetchResult> {
  try {
    return await withCaptureReport(opts, new LinearFetcher());
  } catch (err) {
    if (err instanceof Error && /^Linear API failed \(400\)/.test(err.message)) {
      throw new Error(`${err.message} ${LINEAR_400_HINT}`);
    }
    throw err;
  }
}
