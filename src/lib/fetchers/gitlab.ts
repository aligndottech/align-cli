import type { PersonalImportItem } from '../personal-import.js';

export async function fetchGitLabItems(opts: {
  token: string;
  domain?: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  const base = `https://${opts.domain ?? 'gitlab.com'}/api/v4`;
  const headers = { Authorization: `Bearer ${opts.token}` };

  const userRes = await fetch(`${base}/user`, { headers });
  if (!userRes.ok) throw new Error(`GitLab auth failed (${userRes.status}). Check your token has 'read_api' scope.`);
  const user = await userRes.json() as { id: number };

  const limit = opts.limit ?? 100;
  const items: PersonalImportItem[] = [];

  const mrRes = await fetch(
    `${base}/merge_requests?author_id=${user.id}&state=merged&per_page=${Math.min(limit, 50)}&order_by=updated_at`,
    { headers },
  );
  if (mrRes.ok) {
    const mrs = await mrRes.json() as Array<{ web_url: string; title: string; description: string | null; state: string }>;
    for (const mr of mrs) {
      items.push({
        source_url: mr.web_url,
        platform: 'gitlab',
        raw_text: `${mr.title}\n\n${mr.description ?? ''}\n\nStatus: ${mr.state}`.trim(),
        title: mr.title,
      });
    }
  }

  return items.slice(0, limit);
}
