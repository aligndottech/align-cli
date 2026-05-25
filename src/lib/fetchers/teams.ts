import type { PersonalImportItem } from '../personal-import.js';

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface TeamsTeam { id: string; displayName: string }
interface TeamsChannel { id: string; displayName: string }
interface TeamsMessageBody { content?: string; contentType?: string }
interface TeamsMessage {
  id: string;
  subject?: string;
  webUrl?: string;
  body?: TeamsMessageBody;
  replies?: Array<{ body?: TeamsMessageBody }>;
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    const code = err.error?.code ?? '';
    if (res.status === 403 || code.includes('Authorization') || code.includes('Consent')) {
      throw new Error(
        'Teams requires admin consent for ChannelMessage.Read.All. ' +
        'Ask your Microsoft 365 admin to grant consent, or see: ' +
        'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ConsentPoliciesMenuBlade',
      );
    }
    throw new Error(`Microsoft Graph API error ${res.status} on ${path}: ${err.error?.message ?? 'unknown'}`);
  }
  return res.json() as Promise<T>;
}

function extractText(body: TeamsMessageBody | undefined): string {
  if (!body?.content) return '';
  return body.contentType === 'html' ? stripHtml(body.content) : body.content;
}

export async function fetchTeamsItems(opts: {
  token: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  const limit = opts.limit ?? 50;
  const teams = await graphGet<{ value: TeamsTeam[] }>('/me/joinedTeams', opts.token);
  const items: PersonalImportItem[] = [];

  for (const team of teams.value) {
    if (items.length >= limit) break;
    const channels = await graphGet<{ value: TeamsChannel[] }>(
      `/teams/${team.id}/channels`, opts.token,
    );
    for (const channel of channels.value) {
      if (items.length >= limit) break;
      try {
        const msgs = await graphGet<{ value: TeamsMessage[] }>(
          `/teams/${team.id}/channels/${channel.id}/messages?$top=10`, opts.token,
        );
        for (const msg of msgs.value) {
          if (items.length >= limit) break;
          const mainText = extractText(msg.body);
          const replyTexts = (msg.replies ?? []).map(r => extractText(r.body)).filter(Boolean);
          const raw_text = [
            `[${team.displayName} > #${channel.displayName}]`,
            msg.subject ? `Subject: ${msg.subject}` : '',
            mainText,
            ...replyTexts,
          ].filter(Boolean).join('\n');

          items.push({
            source_url: msg.webUrl ?? 'https://teams.microsoft.com',
            platform: 'teams',
            raw_text,
            title: (msg.subject ?? mainText).slice(0, 80) || `Message in ${team.displayName}`,
          });
        }
      } catch { /* skip inaccessible channels */ }
    }
  }

  return items;
}
