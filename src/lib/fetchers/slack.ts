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
  user?: string;
}

/** Resolve a Slack user id to a display name (cached - one users.info call per unique user). */
function makeUserResolver(token: string) {
  const cache = new Map<string, { name: string; handle?: string; email?: string } | null>();
  return async (userId: string | undefined): Promise<{ name: string; handle?: string; email?: string } | undefined> => {
    if (!userId) return undefined;
    if (cache.has(userId)) return cache.get(userId) ?? undefined;
    try {
      const data = await slackGet('users.info', token, { user: userId });
      const u = (data.user ?? {}) as { name?: string; real_name?: string; profile?: { real_name?: string; display_name?: string; email?: string } };
      const name = u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || userId;
      const resolved = { name, ...(u.name ? { handle: u.name } : {}), ...(u.profile?.email ? { email: u.profile.email } : {}) };
      cache.set(userId, resolved);
      return resolved;
    } catch {
      cache.set(userId, null); // don't retry a failed lookup
      return undefined;
    }
  };
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

  const resolveUser = makeUserResolver(opts.token);
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
          // Who to talk to (ALI-118): the thread starter (original poster).
          const author = await resolveUser(allMsgs[0]?.user ?? thread.user);
          items.push({
            source_url: `https://slack.com/archives/${channel.id}/p${thread.ts.replace('.', '')}`,
            platform: 'slack',
            raw_text: `[#${channel.name}] Thread:\n${text}`,
            title: (thread.text ?? `Thread in #${channel.name}`).slice(0, 80),
            ...(author ? { author } : {}),
          });
        } catch { /* skip individual thread errors */ }
      }
    } catch { /* skip channels that are inaccessible */ }
  }

  return items;
}
