import { JiraFetcher, FetcherAuthError } from '@aligndottech/connector-core';
import { AuthExpiredError } from '../errors.js';
import type { PersonalImportItem } from '../personal-import.js';

/** Read-only personal Jira import. Delegates to the canonical fetcher in
 *  @aligndottech/connector-core; maps its auth error to the CLI's reconnect flow. */
export async function fetchJiraItems(opts: {
  token: string;
  cloudId?: string;
  siteBase?: string;
  email?: string;
  domain?: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  try {
    return await new JiraFetcher().fetch(opts);
  } catch (e) {
    if (e instanceof FetcherAuthError) throw new AuthExpiredError(e.connector);
    throw e;
  }
}
