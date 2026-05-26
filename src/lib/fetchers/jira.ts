import { AuthExpiredError } from '../errors.js';
import type { PersonalImportItem } from '../personal-import.js';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: {
      content?: Array<{ content?: Array<{ text?: string }> }>;
    } | null;
    status?: { name: string };
    comment?: {
      comments: Array<{
        author?: { displayName?: string };
        body?: { content?: Array<{ content?: Array<{ text?: string }> }> };
      }>;
    };
  };
}

function extractAdfText(adf: { content?: Array<{ content?: Array<{ text?: string }> }> } | null | undefined): string {
  if (!adf) return '';
  return (adf.content ?? [])
    .flatMap(block => (block.content ?? []).map(inline => inline.text ?? ''))
    .join(' ')
    .trim();
}

export async function fetchJiraItems(opts: {
  token: string;
  cloudId?: string;
  siteBase?: string;
  email?: string;
  domain?: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  const isOAuth = Boolean(opts.cloudId);
  const base = isOAuth
    ? `https://api.atlassian.com/ex/jira/${opts.cloudId}`
    : `https://${opts.domain}`;
  const headers: Record<string, string> = isOAuth
    ? { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' }
    : { Authorization: `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`, Accept: 'application/json' };

  const limit = opts.limit ?? 100;
  const jql = 'assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC';
  const url = `${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=summary,description,comment,status,key`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AuthExpiredError('Jira');
    const text = await res.text();
    throw new Error(`Jira API failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { issues: JiraIssue[] };

  // For OAuth mode use the human site base URL (e.g. https://company.atlassian.net)
  const browseBase = isOAuth
    ? (opts.siteBase ?? `https://api.atlassian.com/ex/jira/${opts.cloudId}`)
    : base;

  return data.issues.map(issue => {
    const comments = (issue.fields.comment?.comments ?? [])
      .slice(-3)
      .map(c => {
        const text = extractAdfText(c.body);
        return `${c.author?.displayName ?? 'Unknown'}: ${text}`;
      })
      .filter(c => c.trim().length > 0)
      .join('\n');
    const desc = extractAdfText(issue.fields.description);
    return {
      source_url: `${browseBase}/browse/${issue.key}`,
      platform: 'jira',
      raw_text: [
        `[${issue.key}] ${issue.fields.summary}`,
        desc,
        issue.fields.status?.name ? `Status: ${issue.fields.status.name}` : '',
        comments ? `Comments:\n${comments}` : '',
      ].filter(Boolean).join('\n\n'),
      title: `[${issue.key}] ${issue.fields.summary}`,
    };
  });
}
