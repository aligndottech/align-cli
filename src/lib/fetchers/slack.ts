import { SlackFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';

/**
 * Read-only personal Slack import (canonical fetcher in connector-core).
 *
 * ALI-786 finding 1 (a 0.29.1 field report: deletion tombstones - "This message was
 * deleted." - captured as decisions) is already fixed upstream, not here: SlackFetcher's
 * SYSTEM_SUBTYPES set (connector-core >=0.6.0, ALI-828) excludes a `tombstone` subtype
 * message from ever becoming a thread's title/identity, and this package.json pins
 * ^0.7.0. Do not add a second tombstone filter in this wrapper - connector-core is the
 * one owner of Slack's subtype vocabulary, and a duplicate copy here would drift the
 * moment Slack adds a subtype the SDK learns about and this file does not
 * (code-style.md, "a type and a database constraint are two writers of one fact").
 */
export async function fetchSlackItems(opts: { token: string; limit?: number; daysBack?: number }): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new SlackFetcher());
}
