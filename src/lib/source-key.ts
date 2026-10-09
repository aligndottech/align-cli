/**
 * L2: the identity of a connector item that is exactly one thing per URL - a PR, an issue, an
 * MR, a page, a Slack or Teams thread, a Zoom recording, a git commit. Two rows with the same
 * key are one item whose title was edited, which the (source_url, title) key cannot see.
 *
 * Local copy until connector-core 0.10.0 publishes the shared normaliser (plan phase S1); L3
 * replaces the body with a re-export. src/__tests__/source-key.test.ts is the fixture table.
 *
 * Gated on the item's URL SHAPE, per platform, not on the platform alone. A fetcher can fall
 * back to a URL that names a site rather than an item (Confluence's `linkBase`, Teams'
 * `https://teams.microsoft.com`), and keying on one of those would merge every item that fell
 * back into a single row. No key means the row keeps the (source_url, title) identity it has
 * today, so an unrecognised shape costs a possible twin, never a wrong merge.
 */

/** Per platform: the path shapes that address one item, and the query parameters that are
 *  part of its identity. Everything else in the query, and the fragment, is dropped. */
const ITEM_SHAPES: Record<string, { paths: RegExp[]; keepQuery?: string[] }> = {
  github: { paths: [/^\/[^/]+\/[^/]+\/(pull|issues|commit)\/[^/]+$/] },
  gitlab: { paths: [/^\/.+\/-\/(merge_requests|issues|commit)\/[^/]+$/] },
  jira: { paths: [/\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+$/] },
  linear: { paths: [/\/issue\/[A-Za-z0-9]+-\d+(\/[^/]*)?$/] },
  confluence: {
    paths: [/\/pages\/\d+(\/[^/]*)?$/, /\/pages\/viewpage\.action$/],
    keepQuery: ['pageId'],
  },
  notion: { paths: [/[0-9a-f]{32}$/i] },
  slack: { paths: [/^\/archives\/[A-Za-z0-9]+\/p\d+$/], keepQuery: ['thread_ts'] },
  teams: { paths: [/^\/l\/message\/[^/]+\/\d+$/] },
  zoom: { paths: [/^\/recording\/[^/]+$/] },
  git: { paths: [/\/commit\/[0-9a-f]{7,40}$/i] },
};

export function normaliseSourceKey(platform: string, url: string | null | undefined): string | undefined {
  const shape = ITEM_SHAPES[platform];
  if (!shape || !url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
  // git://commit/<sha> parses with `commit` as the host, so the shape is read off host + path.
  const shapePath = parsed.protocol === 'git:' ? `//${parsed.host}${path}` : path;
  const keep = shape.keepQuery ?? [];
  const query = keep
    .filter(k => parsed.searchParams.has(k))
    .map(k => `${k}=${parsed.searchParams.get(k)}`)
    .join('&');
  // The query can be the identity (Confluence's viewpage.action?pageId=), so a path shape
  // that needs one is only an item when the parameter is present.
  if (!shape.paths.some(p => p.test(shapePath))) return undefined;
  if (shapePath.endsWith('viewpage.action') && !query) return undefined;
  // URL lowercases the scheme and host already; the path keeps its case (o/R and o/r are
  // different repos on a case-sensitive self-hosted forge, and Jira keys are case-sensitive).
  return `${parsed.protocol}//${parsed.host}${path}${query ? `?${query}` : ''}`;
}
