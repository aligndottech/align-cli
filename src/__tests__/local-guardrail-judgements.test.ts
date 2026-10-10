import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.75),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn(),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { classifyRelationship } from '../lib/local-relationship-classifier.js';
import { applyJudgement, contextKeyFor } from '../lib/curation/mark.js';
import { DatabaseSync } from 'node:sqlite';
import { checkVerdictFor } from '../lib/curation/judgements-db.js';

/**
 * LM Test List (the local guardrail honours a person's marks):
 * - A false check verdict hides the hit for the SAME file set (any order) and only that set.
 * - Another file set still shows it, annotated with the date of the earlier false alarm.
 * - A later `real` for the set shows it again; another judge's `false` hides nothing for this judge.
 * - not_a_decision removes a decision from ask AND check retrieval; undoing it restores both.
 * - A supersede mark makes a check that cites the older decision name the newer as current.
 * - getConflicts annotates pairs this judge marked, in either order, and leaves unmarked pairs as they were.
 * - A conflicting check lists the files it covered; an aligned one does not.
 */
const diffOf = (...files: string[]) => files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
const conflictReply = { ok: true, relationship: { type: 'conflicts_with', confidence: 0.9, reason: 'opposes it' } } as const;

describe('local guardrail honours local judgements', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  let a: string;
  let b: string;
  const me = { judgeId: 'me', judgeLabel: null };
  const mark = (m: Parameters<typeof applyJudgement>[1], judge = me, undo = false) =>
    applyJudgement({ dbPath, judge, origin: { via: 'cli' } }, m, { undo });

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `align-lm-guard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    client = createLocalGatewayClient(dbPath, { judgeId: 'me' });
    vi.mocked(classifyRelationship).mockResolvedValue(conflictReply);
    a = (await client.captureDecision('Use Postgres for persistence', 'cli')).id;
    b = (await client.captureDecision('Use MySQL for the reporting store', 'cli')).id;
  });
  afterEach(() => {
    client.close();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  const hitIds = (r: Awaited<ReturnType<typeof client.checkAlignment>>) => (r.conflicts ?? []).map((c) => c.decision_id).sort();

  it('hides a false-alarm hit for the same file set in any order, and shows it for another set with a note', async () => {
    const before = await client.checkAlignment(diffOf('x.ts', 'y.ts'));
    expect(hitIds(before)).toEqual([a, b].sort());
    mark({ action: 'check', id: a, verdict: 'false', files: ['y.ts', 'x.ts'] });

    const same = await client.checkAlignment(diffOf('y.ts', 'x.ts'));
    expect(hitIds(same)).toEqual([b]);
    expect(same.notes?.join('\n')).toMatch(/hidden.*marked false by you/i);

    const elsewhere = await client.checkAlignment(diffOf('z.ts'));
    expect(hitIds(elsewhere)).toEqual([a, b].sort());
    expect(elsewhere.notes?.join('\n')).toContain('you marked this a false alarm once');
    expect(elsewhere.notes?.join('\n')).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('a verdict an agent relayed hides only the same file set, and says so with the agent\'s name', async () => {
    applyJudgement({ dbPath, judge: me, origin: { via: 'mcp', agentId: 'claude-code' } }, { action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    const same = await client.checkAlignment(diffOf('x.ts'));
    expect(hitIds(same)).toEqual([b]);
    expect(same.notes?.join('\n')).toContain('marked false by claude-code via MCP');
    const elsewhere = await client.checkAlignment(diffOf('z.ts'));
    expect(hitIds(elsewhere)).toEqual([a, b].sort());
    expect(elsewhere.notes?.join('\n')).toContain('marked false by claude-code via MCP');
    expect(elsewhere.notes?.join('\n')).not.toContain('you marked');
  });

  it('a hit hidden by the person is never described as the agent\'s (the attribution is per row)', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    expect((await client.checkAlignment(diffOf('x.ts'))).notes?.join('\n')).not.toContain('MCP');
  });

  it('a hit with no verdict at all carries no notes (the annotation is not blanket)', async () => {
    const r = await client.checkAlignment(diffOf('x.ts'));
    expect(r.notes).toBeUndefined();
  });

  it('when every hit is hidden the status is no longer conflicting', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    mark({ action: 'check', id: b, verdict: 'false', files: ['x.ts'] });
    const r = await client.checkAlignment(diffOf('x.ts'));
    expect(r.status).toBe('aligned');
    expect(r.conflicts).toEqual([]);
  });

  it('a later real verdict for the set shows the hit again', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    mark({ action: 'check', id: a, verdict: 'real', files: ['x.ts'] });
    expect(hitIds(await client.checkAlignment(diffOf('x.ts')))).toEqual([a, b].sort());
  });

  it('a real verdict for this set beats an old false alarm for another set: shown, and not annotated as a false alarm', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['y.ts'] });
    mark({ action: 'check', id: a, verdict: 'real', files: ['x.ts'] });
    const r = await client.checkAlignment(diffOf('x.ts'));
    expect(hitIds(r)).toEqual([a, b].sort());
    expect(r.notes).toBeUndefined();
  });

  it('another judge\'s false verdict hides nothing for this judge', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] }, { judgeId: 'someone-else', judgeLabel: null });
    expect(hitIds(await client.checkAlignment(diffOf('x.ts')))).toEqual([a, b].sort());
  });

  it('a diff naming no files is never suppressed (there is no file set to match)', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    expect(hitIds(await client.checkAlignment('plain prose, not a diff'))).toEqual([a, b].sort());
  });

  it('lists the files it covered on a conflicting check, and not on an aligned one', async () => {
    const hit = await client.checkAlignment(diffOf('src/b.ts', 'src/a.ts', 'src/a.ts'));
    expect(hit.checked_files).toEqual(['src/a.ts', 'src/b.ts']);
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: true, relationship: { type: 'relates_to', confidence: 0.6, reason: 'related' } } as never);
    const fine = await client.checkAlignment(diffOf('src/a.ts'));
    expect(fine.status).toBe('aligned');
    expect(fine.checked_files).toBeUndefined();
  });

  it('not-a-decision removes a decision from check and ask, and undo brings it back (two decisions)', async () => {
    mark({ action: 'not-a-decision', id: a });
    expect(hitIds(await client.checkAlignment(diffOf('x.ts')))).toEqual([b]);
    expect((await client.searchDecisions('storage')).results.map((r) => r.id)).toEqual([b]);
    mark({ action: 'not-a-decision', id: b });
    expect((await client.checkAlignment(diffOf('x.ts'))).status).toBe('no-context');
    mark({ action: 'not-a-decision', id: a }, me, true);
    expect(hitIds(await client.checkAlignment(diffOf('x.ts')))).toEqual([a]);
    expect((await client.searchDecisions('storage')).results.map((r) => r.id)).toEqual([a]);
  });

  it('still lists a not-a-decision row in decisions list (kept, not deleted)', async () => {
    mark({ action: 'not-a-decision', id: a });
    expect((await client.listDecisions({ all: true })).map((d) => d.id)).toContain(a);
  });

  it('a supersede mark makes a check that cites the older decision name the newer as current', async () => {
    mark({ action: 'replaces', newer: b, older: a });
    const r = await client.checkAlignment(diffOf('x.ts'));
    const older = r.relevant_decisions.find((d) => d.id === a) as { status?: string; successor?: { id: string } } | undefined;
    expect(older?.status).toBe('superseded');
    expect(older?.successor?.id).toBe(b);
    const newer = r.relevant_decisions.find((d) => d.id === b) as { status?: string } | undefined;
    expect(newer?.status).toBeUndefined();
  });

  it('getConflicts annotates a pair this judge marked in either order, and leaves another pair alone', async () => {
    const c = (await client.captureDecision('Use Redis for caching', 'cli')).id;
    const db = (await import('../lib/local-db.js')).createLocalDb(dbPath);
    db.insertLink({ sourceId: a, targetId: b, relation: 'conflicts_with', confidence: 0.9 });
    db.insertLink({ sourceId: a, targetId: c, relation: 'conflicts_with', confidence: 0.9 });
    db.close();
    mark({ action: 'conflict', a: b, b: a, verdict: 'false' });
    const links = (await client.getConflicts()).links as Array<{ sourceId: string; targetId: string; marked_by_you?: { verdict: string; note: string } }>;
    const ab = links.find((l) => l.targetId === b)!;
    const ac = links.find((l) => l.targetId === c)!;
    expect(ab.marked_by_you).toMatchObject({ verdict: 'false' });
    expect(ab.marked_by_you?.note).toContain('marked false alarm by you');
    expect(ac.marked_by_you).toBeUndefined();
  });

  it('getConflicts names the agent that marked a pair', async () => {
    const db = (await import('../lib/local-db.js')).createLocalDb(dbPath);
    db.insertLink({ sourceId: a, targetId: b, relation: 'conflicts_with', confidence: 0.9 });
    db.close();
    applyJudgement({ dbPath, judge: me, origin: { via: 'mcp', agentId: 'codex' } }, { action: 'conflict', a, b, verdict: 'false' });
    const links = (await client.getConflicts()).links as Array<{ marked_by_you?: { note: string } }>;
    expect(links[0].marked_by_you?.note).toContain('marked false alarm by codex via MCP');
  });

  it('the key a check verdict is stored under is the hash of the sorted file list', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['y.ts', 'x.ts'] });
    expect(checkVerdictFor(dbPath, 'me', a, contextKeyFor(['x.ts', 'y.ts'])).here?.value).toBe('false');
  });

  // A row written the way an older build let an agent write it (the tool refuses these now).
  const legacyAgentRow = (kind: string, decisionId: string, extra: Record<string, string | null> = {}) => {
    const d = new DatabaseSync(dbPath);
    const row = { id: `legacy-${kind}-${decisionId}`, decision_id: decisionId, kind, judge_id: 'me', via: 'mcp', agent_id: 'claude-code', judged_at: '2026-10-01T00:00:00.000Z', counterpart_id: null, context_key: null, value: null, ...extra };
    const cols = Object.keys(row);
    d.prepare(`INSERT INTO local_judgements (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
    d.close();
  };

  describe('a mark that drops a decision is never silent (F1, F11)', () => {
    it('a check whose only candidates were dropped is no-context WITH the reason, never plain no-context', async () => {
      mark({ action: 'not-a-decision', id: a });
      mark({ action: 'not-a-decision', id: b });
      const r = await client.checkAlignment(diffOf('db.ts'));
      expect(r.status).toBe('no-context');
      expect(r.notes).toContain('2 related decisions are hidden by your marks (run `align mark --list`)');
      expect(r.message).toContain('2 related decisions are hidden by your marks');
      expect(r.notes?.join('\n')).toMatch(/"Use Postgres for persistence" was left out of this check: marked not a decision by you on \d{4}-\d{2}-\d{2}/);
    });
    it('one decision dropped: the singular summary, and the other hit still blocks', async () => {
      mark({ action: 'not-a-decision', id: a });
      const r = await client.checkAlignment(diffOf('db.ts'));
      expect(r.status).toBe('conflicting');
      expect(hitIds(r)).toEqual([b]);
      expect(r.notes?.join('\n')).toContain('"Use Postgres for persistence" was left out of this check');
      mark({ action: 'not-a-decision', id: b });
      expect((await client.checkAlignment(diffOf('db.ts'))).notes).toContain('2 related decisions are hidden by your marks (run `align mark --list`)');
    });
    it('names an agent that did it (an older row), by name and via MCP', async () => {
      legacyAgentRow('not_a_decision', a);
      const r = await client.checkAlignment(diffOf('db.ts'));
      expect(r.notes?.join('\n')).toContain('marked not a decision by claude-code via MCP on 2026-10-01');
    });
    it('F11: a person\'s real verdict on a file set does not make a hidden decision invisible', async () => {
      mark({ action: 'check', id: a, verdict: 'real', files: ['src/db.ts'] });
      mark({ action: 'not-a-decision', id: a });
      mark({ action: 'not-a-decision', id: b });
      const r = await client.checkAlignment(diffOf('src/db.ts'));
      expect(r.status).toBe('no-context');
      expect(r.notes?.join('\n')).toContain('2 related decisions are hidden by your marks');
    });
    it('a decision that would not have made the top five is not reported as left out', async () => {
      const db = (await import('../lib/local-db.js')).createLocalDb(dbPath);
      const extra = Array.from({ length: 6 }, (_, i) => db.insertDecision({ title: `filler ${i}`, summary: 'f', sourceUrl: `https://example.com/f${i}`, platform: 'cli' }));
      db.close();
      for (const id of extra) mark({ action: 'not-a-decision', id });
      const r = await client.checkAlignment(diffOf('db.ts'));
      expect(r.notes?.join('\n') ?? '').not.toContain('filler 5');
    });
    it('the retrieval-only path (the hook) carries the note too', async () => {
      mark({ action: 'not-a-decision', id: a });
      const r = await client.checkAlignment(diffOf('db.ts'), undefined, { depth: 'related' });
      expect(r.status).toBe('retrieved');
      expect(r.notes?.join('\n')).toContain('was left out of this check');
    });
    it('ask names what a mark kept out of its answer', async () => {
      mark({ action: 'not-a-decision', id: a });
      const r = await client.searchDecisions('Postgres persistence', 5);
      expect(r.results.map((x) => x.id)).toEqual([b]);
      expect(r.notes?.join('\n')).toContain('"Use Postgres for persistence" was left out');
    });
    it('a title carrying a terminal escape is printed escaped in the note', async () => {
      const esc = (await client.captureDecision('Evil \u001b[8mhidden title', 'cli')).id;
      mark({ action: 'not-a-decision', id: esc });
      const r = await client.checkAlignment(diffOf('db.ts'));
      expect(r.notes?.join('\n')).toContain('\\u001b[8m');
      expect(r.notes?.join('')).not.toContain('\u001b');
    });
  });

  describe('every check says while an agent\'s marks shape it (banner)', () => {
    it('no banner while only the person has marked', async () => {
      mark({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
      expect((await client.checkAlignment(diffOf('z.ts'))).notes?.join('\n')).not.toMatch(/by agents/);
    });
    it('an agent\'s false verdict puts the banner on a check that does not touch its file set, and counts correctly (two rows)', async () => {
      applyJudgement({ dbPath, judge: me, origin: { via: 'mcp', agentId: 'claude-code' } }, { action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
      const one = await client.checkAlignment(diffOf('z.ts'));
      expect(one.notes?.[0]).toMatch(/^1 mark by agents since \d{4}-\d{2}-\d{2} affects this check \(align mark --list\)$/);
      legacyAgentRow('not_a_decision', b);
      const two = await client.checkAlignment(diffOf('z.ts'));
      expect(two.notes?.[0]).toMatch(/^2 marks by agents since .* affect this check \(align mark --list\)$/);
    });
    it('an agent\'s real verdict, conflict verdict or note does not change a check, so it brings no banner', async () => {
      applyJudgement({ dbPath, judge: me, origin: { via: 'mcp', agentId: 'claude-code' } }, { action: 'check', id: a, verdict: 'real', files: ['x.ts'] });
      applyJudgement({ dbPath, judge: me, origin: { via: 'mcp', agentId: 'claude-code' } }, { action: 'note', id: a, text: 'n' });
      expect((await client.checkAlignment(diffOf('z.ts'))).notes?.join('\n') ?? '').not.toMatch(/by agents/);
    });
    it('it rides on a check that found nothing at all', async () => {
      applyJudgement({ dbPath, judge: me, origin: { via: 'mcp', agentId: 'claude-code' } }, { action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
      vi.mocked((await import('../lib/local-embeddings.js')).cosineSimilarity).mockReturnValue(0);
      const r = await client.checkAlignment(diffOf('z.ts'));
      expect(r.status).toBe('no-context');
      expect(r.notes?.[0]).toMatch(/by agents/);
      vi.mocked((await import('../lib/local-embeddings.js')).cosineSimilarity).mockReturnValue(0.75);
    });
  });

  describe('a person\'s replacement is shown in the check (F2)', () => {
    it('names the older decision as superseded by the newer, who marked it, and when', async () => {
      mark({ action: 'replaces', newer: b, older: a });
      const r = await client.checkAlignment(diffOf('db.ts'));
      expect(r.notes?.join('\n')).toMatch(/"Use Postgres for persistence" is superseded by "Use MySQL for the reporting store": marked by you on \d{4}-\d{2}-\d{2}/);
    });
    it('a supersedes link nobody marked produces no mark note', async () => {
      const db = (await import('../lib/local-db.js')).createLocalDb(dbPath);
      db.insertLink({ sourceId: b, targetId: a, relation: 'supersedes', confidence: 0.9 });
      db.close();
      const r = await client.checkAlignment(diffOf('db.ts'));
      expect((r.relevant_decisions.find((d) => d.id === a) as { status?: string }).status).toBe('superseded');
      expect(r.notes?.join('\n') ?? '').not.toContain('is superseded by');
    });
  });

  it('the MCP check_alignment reply carries the notes, so an agent cannot read a green it was not given', async () => {
    mark({ action: 'not-a-decision', id: a });
    mark({ action: 'not-a-decision', id: b });
    const { dispatchTool, serializeMcpResult } = await import('../commands/mcp.js');
    const reply = JSON.parse(serializeMcpResult(await dispatchTool('align_check_alignment', { diff: diffOf('db.ts') }, client as never, { mode: 'local-embedded', gatewayUrl: '' } as never)));
    expect(reply.status).toBe('no-context');
    expect(reply.notes).toContain('2 related decisions are hidden by your marks (run `align mark --list`)');
  });

  it('F4: more than 500 files hides nothing, and the check says why', async () => {
    const base = Array.from({ length: 500 }, (_, i) => `a/${String(i).padStart(4, '0')}.ts`);
    mark({ action: 'check', id: a, verdict: 'false', files: base });
    const r = await client.checkAlignment(diffOf(...base, ...Array.from({ length: 100 }, (_, i) => `z/${i}.ts`)));
    expect(hitIds(r)).toEqual([a, b].sort());
    expect(r.notes?.join('\n')).toContain('covers 600 files, more than 500');
    expect(r.checked_files).toBeUndefined();
  });

  it('F6: the hint to show a hidden hit again carries the exact files', async () => {
    mark({ action: 'check', id: a, verdict: 'false', files: ['src/db.ts', 'src/my file.ts'] });
    const r = await client.checkAlignment(diffOf('src/my file.ts', 'src/db.ts'));
    expect(r.notes?.join('\n')).toContain(`align mark check ${a} real --files src/db.ts 'src/my file.ts'`);
  });
});
