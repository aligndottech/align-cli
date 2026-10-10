/**
 * L2: the identity of a connector item that is exactly one thing per URL - a PR, an issue, an
 * MR, a page, a Slack or Teams thread, a Zoom recording, a git commit. Two rows with the same
 * key are one item whose title was edited, which the (source_url, title) key cannot see.
 *
 * `normaliseSourceKey` is a behavioural copy of connector-core's function of the same name
 * (align-connector-sdk, packages/connector-core/src/sourceKey.ts, commit c44d1d4), until
 * connector-core publishes it and L3 replaces the body with a re-export. Two readers of one
 * format must agree, so src/__tests__/source-key.test.ts runs the SDK's published fixture
 * table (src/__tests__/fixtures/source-key-fixtures.json) against this copy: drift in either
 * fails there. Do not edit the function without editing the SDK's, and re-copying the table.
 *
 * `connectorItemKey` below is local policy, not part of the shared format: which rows may be
 * keyed at all.
 */
import { isSyntheticSource } from './decision-links.js';

/** Query parameters that identify the item on that platform. Everything else is dropped. */
const QUERY_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  confluence: ['pageId'],
  slack: ['thread_ts'],
};

// A Notion page id: 32 lowercase hex characters ending the last path segment.
const NOTION_ID = /(?:^|-)([0-9a-f]{32})$/;
const NOTION_BARE_ID = /^[0-9a-f]{32}$/;

function canonicalPath(platform: string, host: string, path: string): string {
  let out = path;
  if (platform === 'linear') {
    // /<workspace>/issue/<KEY>/<title-slug> -> /<workspace>/issue/<KEY>
    const m = /^(\/[^/]+\/issue\/[^/]+)\/[^/]*$/.exec(out);
    if (m) out = m[1]!;
  }
  if (host === 'github.com') {
    // GitHub resolves owner and repo case-insensitively; the rest keeps its case.
    out = out.replace(/^(\/[^/]+)(\/[^/]+)?/, (_all, owner: string, repo?: string) => (owner + (repo ?? '')).toLowerCase());
  }
  return out.replace(/%[0-9a-fA-F]{2}/g, (esc) => esc.toUpperCase());
}

/** `<prefix>/pages/<id>` for a Confluence page URL in either form, else undefined. */
function confluencePagePath(u: URL): string | undefined {
  const m = /^(.*?)(?:\/spaces\/[^/]+)?\/pages\/(\d+)(?:\/.*)?$/.exec(u.pathname);
  if (m) return `${m[1]}/pages/${m[2]}`;
  const v = /^(.*?)\/pages\/viewpage\.action\/?$/.exec(u.pathname);
  const id = u.searchParams.get('pageId');
  if (v && id && /^\d+$/.test(id)) return `${v[1]}/pages/${id}`;
  return undefined;
}

export function normaliseSourceKey(platform: string, url: string | null | undefined): string | undefined {
  if (!url || isSyntheticSource(url)) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }

  const scheme = u.protocol.toLowerCase();
  let host = u.host.toLowerCase();
  const bare = u.pathname.replace(/\/+$/, '');

  if (platform === 'notion') {
    // A database view with ?p=<id> is a peek at that page, not the database.
    const peek = u.searchParams.get('p');
    const id = peek && NOTION_BARE_ID.test(peek) ? peek : NOTION_ID.exec(bare.split('/').pop() ?? '')?.[1];
    if (id) return `https://www.notion.so/${id}`;
  }

  // A bare host names no item (the Teams fallback, a site root), whatever its query says.
  if (bare === '') return undefined;
  // The OAuth fallback carries a cloudId instead of the site host: no key rather than a second one.
  if (host === 'api.atlassian.com' && bare.startsWith('/ex/')) return undefined;

  if (platform === 'confluence') {
    const page = confluencePagePath(u);
    if (page) return `${scheme}//${host}${page}`;
  }
  if (platform === 'slack' && bare.startsWith('/archives/') && (host === 'slack.com' || host.endsWith('.slack.com'))) {
    host = 'slack.com';
  }
  const path = canonicalPath(platform, host, bare);

  const allowed = QUERY_ALLOWLIST[platform] ?? [];
  const kept: Array<[string, string]> = [];
  for (const [name, value] of u.searchParams) {
    if (allowed.includes(name)) kept.push([name, value]);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  kept.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';

  return `${scheme}//${host}${path}${query}`;
}

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
