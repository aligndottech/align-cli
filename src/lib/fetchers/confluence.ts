import { AuthExpiredError } from '../errors.js';
import type { PersonalImportItem } from '../personal-import.js';

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface ConfluencePageV2 {
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
  // Confluence API v2. The classic v1 (/rest/api/content/search) rejects tokens
  // granted only the granular *:confluence OAuth scopes with 401 "scope does not
  // match"; v2 works with them. v2 has no creator=currentUser() filter, so this
  // imports the pages the token can read (fine for a read-only personal import).
  const url = `${base}/api/v2/pages?limit=${limit}&body-format=storage`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    // 401 = token genuinely expired/revoked -> re-auth helps. 403 = the token
    // lacks Confluence scopes or this site has no Confluence -> re-auth will NOT
    // help, so don't raise AuthExpiredError (which triggers a reconnect loop).
    if (res.status === 401) throw new AuthExpiredError('Confluence');
    if (res.status === 403) {
      throw new Error(
        'Confluence access denied (403): the token lacks Confluence scopes or this site has no Confluence. ' +
          "Re-auth won't help - check the Atlassian app's Confluence API permissions (or skip Confluence).",
      );
    }
    throw new Error(`Confluence API failed (${res.status}). ${isOAuth ? 'Check your OAuth token.' : 'Check your email, token, and domain.'}`);
  }
  const data = await res.json() as { results: ConfluencePageV2[]; _links?: { base?: string } };

  // v2 page _links.webui is relative; prefer the response's top-level base
  // (e.g. https://company.atlassian.net/wiki), else derive a human site URL.
  const humanBase = isOAuth ? (opts.siteBase ?? `https://api.atlassian.com/ex/confluence/${opts.cloudId}`) : `https://${opts.domain}`;
  const linkBase = data._links?.base ?? `${humanBase}/wiki`;

  return (data.results ?? []).map(page => {
    const bodyHtml = page.body?.storage?.value ?? '';
    const bodyText = stripHtml(bodyHtml).slice(0, 2000);
    const webui = page._links?.webui ?? '';
    const pageUrl = webui.startsWith('http') ? webui : `${linkBase}${webui}`;
    return {
      source_url: pageUrl,
      platform: 'confluence',
      raw_text: [page.title, bodyText].filter(Boolean).join('\n\n'),
      title: page.title,
    };
  });
}
