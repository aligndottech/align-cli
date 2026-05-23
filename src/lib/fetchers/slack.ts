import type { PersonalImportItem } from '../personal-import.js';

async function slackGet(endpoint: string, token: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as Record<string, unknown>;
  if (!data.ok) throw new Error(`Slack API error on ${endpoint}: ${data.error as string}`);
  return data;
}

interface SlackMessage {
  ts: string;
  text?: string;
  reply_count?: number;
}

interface SlackChannel {
  id: string;
  name: string;
}

export async function fetchSlackItems(opts: {
  token: string;
  limit?: number;
  daysBack?: number;
}): Promise<PersonalImportItem[]> {
  const limit = opts.limit ?? 50;
  const daysBack = opts.daysBack ?? 90;
  const oldest = String(Math.floor(Date.now() / 1000) - daysBack * 86400);

  await slackGet('auth.test', opts.token);

  const chanData = await slackGet('conversations.list', opts.token, {
    types: 'public_channel,private_channel',
    exclude_archived: 'true',
    limit: '100',
  });
  const channels = (chanData.channels as SlackChannel[]) ?? [];

  const items: PersonalImportItem[] = [];

  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const channel = channels[channelIndex];
    if (items.length >= limit) break;
    try {
      // 3-second delay between channels to stay under Tier 2 rate limit (20 req/min)
      if (channelIndex > 0) await new Promise(r => setTimeout(r, 3000));
      const hist = await slackGet('conversations.history', opts.token, {
        channel: channel.id,
        oldest,
        limit: '100',
      });
      const messages = (hist.messages as SlackMessage[]) ?? [];
      const threads = messages.filter(m => (m.reply_count ?? 0) >= 2);

      for (const thread of threads) {
        if (items.length >= limit) break;
        try {
          const replies = await slackGet('conversations.replies', opts.token, {
            channel: channel.id,
            ts: thread.ts,
          });
          const allMsgs = (replies.messages as SlackMessage[]) ?? [];
          const text = allMsgs.map(m => m.text ?? '').join('\n');
          items.push({
            source_url: `https://slack.com/archives/${channel.id}/p${thread.ts.replace('.', '')}`,
            platform: 'slack',
            raw_text: `[#${channel.name}] Thread:\n${text}`,
            title: (thread.text ?? `Thread in #${channel.name}`).slice(0, 80),
          });
        } catch { /* skip individual thread errors */ }
      }
    } catch { /* skip channels that are inaccessible */ }
  }

  return items;
}
