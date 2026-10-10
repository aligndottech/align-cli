/**
 * The identity of a connector item that is exactly one thing per URL - a PR, an issue, an MR, a
 * page, a Slack or Teams thread, a Zoom recording, a git commit. Two rows with the same key are
 * one item whose title was edited, which the (source_url, title) key cannot see.
 *
 * L3: `normaliseSourceKey` is connector-core's own function, re-exported. Until connector-core
 * 0.10.0 this file held a behavioural copy; one function now decides the key here, in the hosted
 * scan and at share time. src/__tests__/source-key.test.ts runs the SDK's published fixture table
 * (its `./source-key-fixtures.json` export) against it and asserts it is the same function.
 *
 * `connectorItemKey` below is local policy, not part of the shared format: which rows may be
 * keyed at all.
 */
import { normaliseSourceKey } from '@aligndottech/connector-core';

export { normaliseSourceKey } from '@aligndottech/connector-core';

/** Per platform: the path shapes that address ONE item. The SDK function keys any URL that is
 *  not a bare host; this gate stays on top of it so an unrecognised shape (a fetcher fallback
 *  that names a site or a listing) costs a possible twin, never a wrong merge. Local policy. */
const ITEM_SHAPES: Record<string, RegExp[]> = {
  github: [/^\/[^/]+\/[^/]+\/(pull|issues|commit)\/[^/]+$/],
  gitlab: [/^\/.+\/-\/(merge_requests|issues|commit)\/[^/]+$/],
  jira: [/\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+$/],
  linear: [/\/issue\/[A-Za-z0-9]+-\d+(\/[^/]*)?$/],
  confluence: [/\/pages\/\d+(\/[^/]*)?$/, /\/pages\/viewpage\.action$/],
  notion: [/[0-9a-f]{32}$/i],
  slack: [/^\/archives\/[A-Za-z0-9]+\/p\d+$/],
  teams: [/^\/l\/message\/[^/]+\/\d+$/],
  zoom: [/^\/recording\/[^/]+$/],
  git: [/\/commit\/[0-9a-f]{7,40}$/i, /^\/\/commit\/[0-9a-f]{7,40}$/i],
};

/** Every platform a connector import can key. */
export const KEYED_PLATFORMS: readonly string[] = Object.keys(ITEM_SHAPES);

/**
 * The key stored in `decisions.source_key`, or undefined (the row keeps its
 * (source_url, title) identity). The platform is part of the stored string, so a `git` import
 * and a `github` row for the same commit URL are different items and never merge.
 *
 * Only a connector import is ever given one (callers decide that; see insertDecision's
 * `keyed`). The platform alone cannot say: `align capture <PR url>` also stamps `github`.
 */
export function connectorItemKey(platform: string, url: string | null | undefined): string | undefined {
  const shapes = ITEM_SHAPES[platform];
  if (!shapes || !url) return undefined;
  const key = normaliseSourceKey(platform, url);
  if (key === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(key); } catch { return undefined; }
  const path = parsed.protocol === 'git:' ? `//${parsed.host}${parsed.pathname}` : parsed.pathname;
  if (!shapes.some(p => p.test(path))) return undefined;
  return `${platform}|${key}`;
}
