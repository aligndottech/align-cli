import { createLocalDb } from './local-db.js';
import { cosineSimilarity, getEmbedding } from './local-embeddings.js';

export const CONFLICT_THRESHOLD = 0.65;
// Below this similarity between a decision and new content, the content is
// considered to have drifted from the decision.
export const DRIFT_THRESHOLD = 0.5;

export function createLocalGatewayClient(dbPath: string) {
  const db = createLocalDb(dbPath);

  async function findSimilar(
    embedding: Float32Array,
    topK: number,
    threshold = 0.0,
    excludeId?: string,
  ): Promise<Array<{ decisionId: string; score: number }>> {
    const all = db.getAllEmbeddings();
    return all
      .filter(e => e.decisionId !== excludeId)
      .map(e => ({ decisionId: e.decisionId, score: cosineSimilarity(embedding, e.embedding) }))
      .filter(e => e.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  return {
    async whoami() {
      return { email: 'local', tenantId: 'local', mode: 'local-embedded' };
    },

    async captureDecision(input: string, platform = 'cli') {
      let title = input.slice(0, 80);
      let summary = input;
      let sourceUrl: string | null = null;
      try {
        const url = new URL(input);
        sourceUrl = url.href;
        title = url.pathname.split('/').filter(Boolean).pop() ?? url.hostname;
        summary = `Captured from ${url.hostname}`;
      } catch { /* plain text - use as-is */ }

      const id = db.insertDecision({ title, summary, sourceUrl, platform });
      // Embed title + summary so URL captures (whose summary is just "Captured
      // from <host>") still carry the path-derived title's semantic content.
      const embedText = title === summary ? summary : `${title}. ${summary}`;
      const embedding = await getEmbedding(embedText);
      db.setEmbedding(id, embedding);

      // Conflict detection: similarity >= CONFLICT_THRESHOLD -> conflicts_with
      const candidates = await findSimilar(embedding, 10, CONFLICT_THRESHOLD, id);
      const conflicts: string[] = [];
      for (const c of candidates) {
        db.insertLink({ sourceId: id, targetId: c.decisionId, relation: 'conflicts_with', confidence: c.score });
        conflicts.push(c.decisionId);
      }

      return { id, title, summary, sourceUrl, platform, conflicts };
    },

    async searchDecisions(query: string, limit = 10) {
      const embedding = await getEmbedding(query);
      const similar = await findSimilar(embedding, limit, 0.1);
      const decisions = similar
        .map(s => {
          const row = db.getDecisionById(s.decisionId);
          return row ? { ...row, score: s.score } : null;
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);
      return { decisions };
    },

    async checkAlignment(diff: string, _context?: string) {
      const embedding = await getEmbedding(diff);
      const similar = await findSimilar(embedding, 5, 0.3);
      const matches = similar
        .map(s => {
          const row = db.getDecisionById(s.decisionId);
          return row ? { ...row, score: s.score } : null;
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);
      return {
        status: matches.length > 0 ? 'decisions_found' : 'no_decisions',
        matches,
        note: 'Local mode: similarity-based match only. Set ANTHROPIC_API_KEY for AI-generated verdicts.',
      };
    },

    async checkDrift(decisionId: string, content: string, _sourceType?: string) {
      const decisionEmbedding = db.getEmbedding(decisionId);
      if (!decisionEmbedding) return { decisionId, score: null, drifted: null, note: 'Decision not found or not yet embedded.' };
      const contentEmbedding = await getEmbedding(content);
      const score = cosineSimilarity(decisionEmbedding, contentEmbedding);
      return { decisionId, score, drifted: score < DRIFT_THRESHOLD };
    },

    async getImpact(decisionId: string) {
      const allLinks = db.listLinks({ decisionId });
      const upstream = allLinks.filter(l => l.targetId === decisionId);
      const downstream = allLinks.filter(l => l.sourceId === decisionId);
      return { upstream, downstream };
    },

    async getConflicts() {
      const links = db.listLinks({ relation: 'conflicts_with' });
      return { links };
    },
  };
}

export type LocalGatewayClient = ReturnType<typeof createLocalGatewayClient>;
