import type { EnvironmentConfig } from './config.js';
import { createLocalDb } from './local-db.js';
import type { DecisionLink } from './gateway-client.js';
import type { StaleLink } from './stale-code.js';

/** The slice of the gateway client this needs; the cloud client satisfies it, the local one does not. */
export interface LinkSourceClient {
  listDecisionLinks(filters?: { relation?: string }): Promise<{ links: DecisionLink[]; total_count: number }>;
  getDecision(id: string): Promise<{ source_url?: string | null }>;
}

export interface LoadedLinks {
  links: StaleLink[];
  /** Why the set is smaller than expected, to print instead of an empty result. */
  notes: string[];
}

export const LOCAL_EMPTY_NOTE =
  'The local graph has no supersedes links. A keyless git import records only "relates" links between commits, ' +
  'so nothing says which decision replaced which. Record one with `align mark <new> replaces <old>`, or use a team graph (--env prod).';

/** A person's `align mark ... replaces` writes its link under a `mark:` id; every other local edge is the classifier's. */
export function loadLocalLinks(dbPath: string): LoadedLinks {
  const db = createLocalDb(dbPath);
  try {
    const rows = db.listLinks({ relation: 'supersedes' });
    const links: StaleLink[] = rows.flatMap((r) => {
      const nu = db.getDecisionById(r.sourceId);
      const old = db.getDecisionById(r.targetId);
      if (!nu || !old) return [];
      return [{
        oldId: old.id, oldTitle: old.title, oldSourceUrl: old.sourceUrl,
        newId: nu.id, newTitle: nu.title, newSourceUrl: nu.sourceUrl,
        confidence: r.confidence, humanConfirmed: r.id.startsWith('mark:'),
      }];
    });
    return { links, notes: links.length ? [] : [LOCAL_EMPTY_NOTE] };
  } finally {
    db.close();
  }
}

/** Link rows from the team graph, plus each endpoint's source URL from /snapshots/:id. A link is a person's only when the gateway names a non-"ai" method. */
export async function loadTeamLinks(client: LinkSourceClient): Promise<LoadedLinks> {
  const { links: rows, total_count } = await client.listDecisionLinks({ relation: 'supersedes' });
  const notes: string[] = [];
  if (total_count > rows.length) notes.push(`Read the first ${rows.length} of ${total_count} supersedes links.`);
  const urls = new Map<string, Promise<string | null>>();
  const sourceOf = (id: string): Promise<string | null> => {
    let p = urls.get(id);
    if (!p) { p = client.getDecision(id).then((d) => d.source_url ?? null, () => null); urls.set(id, p); }
    return p;
  };
  const links = await Promise.all(rows.map(async (l): Promise<StaleLink> => ({
    oldId: l.to_decision.id, oldTitle: l.to_decision.title, oldSourceUrl: await sourceOf(l.to_decision.id),
    newId: l.from_decision.id, newTitle: l.from_decision.title, newSourceUrl: await sourceOf(l.from_decision.id),
    confidence: Number(l.confidence ?? 0),
    humanConfirmed: typeof l.detection_method === 'string' && l.detection_method !== '' && l.detection_method !== 'ai',
  })));
  if (!links.length) notes.push('The team graph has no supersedes links.');
  return { links, notes };
}

export async function loadStaleLinks(env: EnvironmentConfig, client: LinkSourceClient | null): Promise<LoadedLinks> {
  if (env.mode === 'local-embedded') return loadLocalLinks(env.localDbPath ?? ':memory:');
  if (!client) throw new Error('No gateway client for this environment.');
  return loadTeamLinks(client);
}
