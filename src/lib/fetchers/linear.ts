import type { PersonalImportItem } from '../personal-import.js';

const LINEAR_GQL = 'https://api.linear.app/graphql';

const ISSUES_QUERY = `
query PersonalIssues($first: Int!) {
  viewer {
    assignedIssues(first: $first, orderBy: updatedAt) {
      nodes {
        id title description url
        state { name }
        team { name }
        comments { nodes { body user { name } } }
      }
    }
    createdIssues(first: $first, orderBy: updatedAt) {
      nodes { id title description url state { name } team { name } }
    }
  }
}`;

interface LinearIssueNode {
  id: string;
  title: string;
  description: string | null;
  url: string;
  state?: { name: string };
  team?: { name: string };
  comments?: { nodes: Array<{ body: string; user?: { name: string } }> };
}

export async function fetchLinearItems(opts: {
  token: string;
  limit?: number;
}): Promise<PersonalImportItem[]> {
  const limit = opts.limit ?? 50;
  const res = await fetch(LINEAR_GQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: ISSUES_QUERY, variables: { first: limit } }),
  });
  if (!res.ok) throw new Error(`Linear API failed (${res.status}). Check your personal API token.`);
  const data = await res.json() as { errors?: Array<{ message: string }>; data: { viewer: { assignedIssues: { nodes: LinearIssueNode[] }; createdIssues: { nodes: LinearIssueNode[] } } } };
  if (data.errors?.length) throw new Error(data.errors[0].message);

  const seen = new Set<string>();
  const items: PersonalImportItem[] = [];
  const allIssues = [
    ...(data.data.viewer.assignedIssues?.nodes ?? []),
    ...(data.data.viewer.createdIssues?.nodes ?? []),
  ];

  for (const issue of allIssues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    const comments = (issue.comments?.nodes ?? [])
      .map(c => `${c.user?.name ?? 'Unknown'}: ${c.body}`)
      .join('\n');
    items.push({
      source_url: issue.url,
      platform: 'linear',
      raw_text: [
        issue.title,
        issue.description ?? '',
        issue.team?.name ? `Team: ${issue.team.name}` : '',
        issue.state?.name ? `Status: ${issue.state.name}` : '',
        comments ? `Comments:\n${comments}` : '',
      ].filter(Boolean).join('\n\n'),
      title: issue.title,
    });
  }

  return items.slice(0, limit);
}
