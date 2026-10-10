/**
 * L4: a stand-in for the global `fetch` in suites that run `align setup` / `align connect` end to end. Connecting now looks at what
 * a token can see (a GitHub repo, Jira projects, Confluence spaces, Linear teams); those lookups go through `fetch`, and a test must
 * never reach a real vendor. Install with `vi.stubGlobal('fetch', vendorFetch)`.
 */
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function vendorFetch(url: string | URL | Request): Promise<Response> {
  const u = String(url);
  if (/api\.github\.com\/search\/issues/.test(u)) return json({ total_count: 0, items: [] });
  if (/\/rest\/api\/3\/project\/search/.test(u)) return json({ values: [{ key: 'ALI', name: 'Align' }], isLast: true });
  if (/\/wiki\/api\/v2\/spaces/.test(u)) return json({ results: [{ key: 'ENG', name: 'Engineering' }] });
  if (/api\.linear\.app\/graphql/.test(u)) return json({ data: { teams: { nodes: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }] } } });
  if (/\/api\/v4\/projects\//.test(u)) return json({ id: 1 });
  return json({}, 404);
}
