import type { PersonalImportItem } from '../personal-import.js';

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface ConfluencePage {
  title: string;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

export async function fetchConfluenceItems(opts: {
  email: string;
  token: string;
  domain: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  const base = `https://${opts.domain}/wiki`;
  const auth = Buffer.from(`${opts.email}:${opts.token}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

  const limit = opts.limit ?? 50;
  const cql = encodeURIComponent('creator = currentUser() AND type = page ORDER BY lastModified DESC');
  const url = `${base}/rest/api/content/search?cql=${cql}&limit=${limit}&expand=body.storage,version`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Confluence API failed (${res.status}). Check your email, token, and domain.`);
  const data = await res.json() as { results: ConfluencePage[] };

  return data.results.map(page => {
    const bodyHtml = page.body?.storage?.value ?? '';
    const bodyText = stripHtml(bodyHtml).slice(0, 2000);
    const pageUrl = `https://${opts.domain}/wiki${page._links?.webui ?? ''}`;
    return {
      source_url: pageUrl,
      platform: 'confluence',
      raw_text: [page.title, bodyText].filter(Boolean).join('\n\n'),
      title: page.title,
    };
  });
}
