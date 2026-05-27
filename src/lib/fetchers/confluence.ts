import { AuthExpiredError } from '../errors.js';
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
  token: string;
  cloudId?: string;
  siteBase?: string;
  email?: string;
  domain?: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  const isOAuth = Boolean(opts.cloudId);
  const base = isOAuth
    ? `https://api.atlassian.com/ex/confluence/${opts.cloudId}/wiki`
    : `https://${opts.domain}/wiki`;
  const headers: Record<string, string> = isOAuth
    ? { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' }
    : { Authorization: `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`, Accept: 'application/json' };

  const limit = opts.limit ?? 50;
  const cql = encodeURIComponent('creator = currentUser() AND type = page ORDER BY lastModified DESC');
  const url = `${base}/rest/api/content/search?cql=${cql}&limit=${limit}&expand=body.storage,version`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AuthExpiredError('Confluence');
    throw new Error(`Confluence API failed (${res.status}). ${isOAuth ? 'Check your OAuth token.' : 'Check your email, token, and domain.'}`);
  }
  const data = await res.json() as { results: ConfluencePage[] };

  return data.results.map(page => {
    const bodyHtml = page.body?.storage?.value ?? '';
    const bodyText = stripHtml(bodyHtml).slice(0, 2000);
    // For OAuth mode use the human site base URL (e.g. https://company.atlassian.net)
    const humanBase = isOAuth ? (opts.siteBase ?? `https://api.atlassian.com/ex/confluence/${opts.cloudId}`) : `https://${opts.domain}`;
    const pageUrl = `${humanBase}/wiki${page._links?.webui ?? ''}`;
    return {
      source_url: pageUrl,
      platform: 'confluence',
      raw_text: [page.title, bodyText].filter(Boolean).join('\n\n'),
      title: page.title,
    };
  });
}
