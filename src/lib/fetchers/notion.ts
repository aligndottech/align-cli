import type { PersonalImportItem } from '../personal-import.js';

interface NotionPage {
  id: string;
  url?: string;
  created_by?: { id?: string };
  properties?: {
    title?: { title?: Array<{ plain_text?: string }> };
    Name?: { title?: Array<{ plain_text?: string }> };
    [key: string]: unknown;
  };
}

/** Resolve a Notion user id to a name (cached). Degrades to undefined on failure. */
function makeNotionUserResolver(headers: Record<string, string>) {
  const cache = new Map<string, { name: string; email?: string } | null>();
  return async (userId?: string): Promise<{ name: string; email?: string } | undefined> => {
    if (!userId) return undefined;
    if (cache.has(userId)) return cache.get(userId) ?? undefined;
    try {
      const res = await fetch(`https://api.notion.com/v1/users/${userId}`, { headers });
      if (!res.ok) { cache.set(userId, null); return undefined; }
      const u = (await res.json()) as { name?: string; person?: { email?: string } };
      const resolved = u.name ? { name: u.name, ...(u.person?.email ? { email: u.person.email } : {}) } : null;
      cache.set(userId, resolved);
      return resolved ?? undefined;
    } catch {
      cache.set(userId, null);
      return undefined;
    }
  };
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

function extractPageTitle(page: NotionPage): string {
  return (
    page.properties?.title?.title?.[0]?.plain_text ??
    page.properties?.Name?.title?.[0]?.plain_text ??
    'Untitled'
  );
}

function extractBlockText(block: NotionBlock): string {
  const content = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  return (content?.rich_text ?? []).map(t => t.plain_text ?? '').join('');
}

export async function fetchNotionItems(opts: {
  token: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
  const limit = opts.limit ?? 50;

  const searchRes = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({ filter: { value: 'page', property: 'object' }, page_size: limit }),
  });
  if (!searchRes.ok) throw new Error(`Notion API failed (${searchRes.status}). Check your integration token.`);
  const data = await searchRes.json() as { results: NotionPage[] };

  const resolveUser = makeNotionUserResolver(headers);
  const items: PersonalImportItem[] = [];
  for (const page of data.results) {
    const title = extractPageTitle(page);
    const pageUrl = page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`;
    // Who to talk to (ALI-119): the page creator.
    const author = await resolveUser(page.created_by?.id);

    let bodyText = '';
    try {
      const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=50`, { headers });
      if (blocksRes.ok) {
        const blocks = await blocksRes.json() as { results: NotionBlock[] };
        bodyText = blocks.results.map(extractBlockText).filter(Boolean).join('\n');
      }
    } catch { /* skip block fetch errors */ }

    items.push({
      source_url: pageUrl,
      platform: 'notion',
      raw_text: [title, bodyText].filter(Boolean).join('\n\n').slice(0, 3000),
      title,
      ...(author ? { author } : {}),
    });
  }

  return items;
}
