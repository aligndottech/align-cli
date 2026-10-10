/**
 * L9: the share flow with no I/O of its own beyond the injected client: select, build, scan, price
 * the preview, send, read the answer, record the ledger. `align share`, `align share --confirm` and
 * `align_share` all call it, so the three cannot disagree about what a share is.
 *
 * Order, and why: the secret scan runs on the payload that will be SENT (a refusal names the decision,
 * the field and the placeholder, never the match); an item already shared with an unchanged payload
 * is "already shared" and makes no call; only then is anything previewed. Nothing here sends without
 * the caller having passed `send`, and `prepare` never calls the network except `whoami` (a read).
 */
import { existingTitles, type Judge, listJudgements } from '../curation/judgements-db.js';
import { createLocalDb, type DecisionRow } from '../local-db.js';
import { getLegacyPromotion, getPromotion, listPromotions, markRetracted, recordPromotion } from './ledger.js';
import { buildSharePayload, type SharePayload } from './payload.js';
import { type Destination, renderPreview } from './preview.js';
import { scanForSecrets, type SecretFinding } from './secret-scan.js';
import { type BatchResponse, failedJudgements, type ItemOutcome, readOutcomes } from './wire.js';

export interface ShareClient {
  whoami(): Promise<{ user: { email: string }; tenant: { id: string; name: string } }>;
  shareBatch(items: Array<Record<string, unknown>>): Promise<BatchResponse>;
  getDecision(id: string): Promise<{ title?: string; summary?: string }>;
  archiveDecision(id: string): Promise<void>;
}

export interface ShareContext { dbPath: string; envName: string; client: ShareClient; judge: Judge }

export class ShareError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = 'ShareError'; }
}

export interface Prepared {
  payloads: SharePayload[];
  dest: Destination;
  tenantId: string;
  /** Decisions whose payload is unchanged since the last share: nothing to send. */
  already: Array<{ localId: string; title: string; remoteId: string }>;
  secrets: Array<SecretFinding & { localId: string }>;
  preview: string;
}

/** Batches of at most this many items: 10 x the gateway's 50 judgements per item stays under its 500 per request. */
export const SHARE_BATCH_ITEMS = 10;

export function ratifiedRows(dbPath: string, opts: { owner?: string; sinceIso?: string } = {}): DecisionRow[] {
  const db = createLocalDb(dbPath);
  try {
    return db.listDecisions().filter((r) => r.ratifiedAt !== null
      && (opts.owner === undefined || r.ratifiedBy === opts.owner)
      && (opts.sinceIso === undefined || r.ratifiedAt >= opts.sinceIso));
  } finally { db.close(); }
}

export async function prepare(ctx: ShareContext, ids: string[]): Promise<Prepared> {
  const who = await ctx.client.whoami();
  const tenantId = who.tenant.id;
  const dest: Destination = { workspace: who.tenant.name, env: ctx.envName, email: who.user.email };
  const rows: DecisionRow[] = [];
  const db = createLocalDb(ctx.dbPath);
  try {
    for (const id of ids) {
      const row = db.getDecisionById(id);
      if (!row) throw new ShareError(`No decision ${id} in your local graph. \`align decisions list\` shows what is there.`);
      if (!row.ratifiedAt) throw new ShareError(`${id} has not been ratified, so it stays a claim on this machine.\n  A human stands behind it first: align ratify ${id}`);
      rows.push(row);
    }
  } finally { db.close(); }

  const shared = listPromotions(ctx.dbPath, ctx.envName, tenantId);
  const remoteIdOf = (id: string) => shared.get(id)?.remoteId;
  const payloads: SharePayload[] = [];
  const already: Prepared['already'] = [];
  const secrets: Prepared['secrets'] = [];
  const updates = new Set<string>();
  const legacy = new Set<string>();
  for (const row of rows) {
    const mine = listJudgements(ctx.dbPath, ctx.judge.judgeId, row.id);
    const others = [...new Set(mine.flatMap((j) => [j.decision_id, j.counterpart_id]).filter((x): x is string => x !== null && x !== row.id))];
    const titles = existingTitles(ctx.dbPath, others);
    const p = buildSharePayload({ row, judgements: mine, remoteIdOf, titleOf: (id) => titles.get(id) ?? null });
    const fields = [
      { field: 'title', text: p.item.title }, { field: 'summary', text: p.item.raw_text }, { field: 'source_url', text: p.item.source_url },
      ...p.item.judgements.map((j, i) => ({ field: `note ${i + 1}`, text: j.note })),
    ];
    for (const f of scanForSecrets(fields)) secrets.push({ ...f, localId: row.id });
    const prior = getPromotion(ctx.dbPath, row.id, ctx.envName, tenantId);
    if (prior && prior.retractedAt === null) {
      if (prior.contentHash === p.hash) { already.push({ localId: row.id, title: row.title, remoteId: prior.remoteId }); continue; }
      updates.add(row.id);
    } else if (!prior && getLegacyPromotion(ctx.dbPath, row.id, ctx.envName)) legacy.add(row.id);
    payloads.push(p);
  }
  return { payloads, dest, tenantId, already, secrets, preview: renderPreview(payloads, dest, { updates, legacy }) };
}

/** The refusal text: where, which kind, never the value. */
export function secretRefusal(secrets: Prepared['secrets']): string {
  const lines = secrets.map((s) => `  ${s.localId}: ${s.field} looks like ${s.placeholder}`);
  return `Nothing was sent: part of what would be shared looks like a credential.\n${lines.join('\n')}\n  Edit it out of the decision, then share again.`;
}

export type RowResult = { localId: string; title: string; outcome: ItemOutcome; judgementFailures: Array<{ index: number; error: string }> };

export interface SendHooks {
  /** A matched share whose ratify/supersede wait on the team's text: show it, return whether the person agrees. */
  confirmTeamText?: (info: { localId: string; title: string; teamTitle: string; teamSummary: string }) => Promise<boolean>;
}

async function postBatch(ctx: ShareContext, batch: SharePayload[]): Promise<ItemOutcome[]> {
  const res = await ctx.client.shareBatch(batch.map((p) => ({ ...p.item, judgements: p.item.judgements })));
  return readOutcomes(batch.length, res);
}

export async function send(ctx: ShareContext, prep: Prepared, hooks: SendHooks = {}): Promise<RowResult[]> {
  const results: RowResult[] = [];
  for (let at = 0; at < prep.payloads.length; at += SHARE_BATCH_ITEMS) {
    const batch = prep.payloads.slice(at, at + SHARE_BATCH_ITEMS);
    const outcomes = await postBatch(ctx, batch);
    for (const [k, p] of batch.entries()) {
      let outcome = outcomes[k]!;
      // A matched share: ratify and supersede are NOT stored until the person has seen the TEAM's text.
      if (outcome.kind === 'matched' && outcome.needsConfirmation.length > 0 && outcome.teamTextHash && hooks.confirmTeamText) {
        const team = await ctx.client.getDecision(outcome.remoteId).catch(() => null);
        const agreed = team !== null && await hooks.confirmTeamText({ localId: p.localId, title: p.item.title, teamTitle: team.title ?? '', teamSummary: team.summary ?? '' });
        if (agreed) {
          const need = new Set(outcome.needsConfirmation.map((n) => n.judgement_index));
          const hash = outcome.teamTextHash;
          const again = { ...p, item: { ...p.item, judgements: p.item.judgements.map((j, i) => (need.has(i) ? { ...j, confirm_team_text_hash: hash } : j)) } };
          outcome = (await postBatch(ctx, [again]))[0]!;
        }
      }
      const judgementFailures = 'judgements' in outcome ? failedJudgements(outcome.judgements) : [];
      results.push({ localId: p.localId, title: p.item.title, outcome, judgementFailures });
      if (outcome.kind === 'created' || outcome.kind === 'updated') {
        recordPromotion(ctx.dbPath, { localId: p.localId, env: ctx.envName, tenantId: prep.tenantId, remoteId: outcome.remoteId, contentHash: p.hash, matched: false });
      } else if (outcome.kind === 'matched' && judgementFailures.every((f) => f.error === 'needs_confirmation')) {
        // Only a settled match is remembered; one still waiting on the team-text confirmation is re-offered next time.
        if (outcome.needsConfirmation.length === 0 || judgementFailures.length === 0) {
          recordPromotion(ctx.dbPath, { localId: p.localId, env: ctx.envName, tenantId: prep.tenantId, remoteId: outcome.remoteId, contentHash: p.hash, matched: true });
        }
      }
    }
  }
  return results;
}

const FAIL_TEXT: Record<string, string> = {
  needs_confirmation: 'waits for you to confirm the team\'s text (run the share again and answer yes)',
  team_text_changed: 'the team\'s text changed while you were looking; share again',
  ratification_not_permitted: 'your role may not ratify here',
  decision_not_found: 'the other decision is not visible to you',
};

export function renderResults(rows: readonly RowResult[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    const o = r.outcome;
    const head = ((): string => {
      switch (o.kind) {
        case 'created': return o.ambiguous ? `shared as new (several team decisions share this source, so it was not matched): ${o.remoteId}` : `created: ${o.remoteId}`;
        case 'updated': return `updated: ${o.remoteId}`;
        case 'matched': return `matched an existing team decision (${o.remoteId}); your judgements were added, its text is untouched`;
        case 'skipped': return `left alone (${o.reason}): ${o.remoteId}`;
        case 'refused': return `refused by the server (${o.reason})`;
        case 'unknown': return 'the server did not say what happened to it; check your team graph before sharing again';
      }
    })();
    lines.push(`  ${r.title}\n    ${head}`);
    for (const f of r.judgementFailures) lines.push(`    judgement ${f.index + 1} not stored: ${FAIL_TEXT[f.error] ?? f.error}`);
  }
  return lines.join('\n');
}

export interface RetractResult { ok: boolean; message: string }

export async function retract(ctx: ShareContext, localId: string): Promise<RetractResult> {
  const who = await ctx.client.whoami();
  const row = getPromotion(ctx.dbPath, localId, ctx.envName, who.tenant.id);
  if (!row || row.retractedAt !== null) {
    if (getLegacyPromotion(ctx.dbPath, localId, ctx.envName)) return { ok: false, message: `${localId} was pushed before Align tracked workspaces, so it cannot be retracted from here. Archive it on your team graph.` };
    return { ok: false, message: `Nothing to retract: ${localId} was not shared to ${who.tenant.name} (${ctx.envName}) from this machine.` };
  }
  if (row.matched) {
    return { ok: false, message: `${localId} attached to a decision your team already held (${row.remoteId}). Retracting would archive THEIR decision, so nothing was done.` };
  }
  await ctx.client.archiveDecision(row.remoteId);
  markRetracted(ctx.dbPath, localId, ctx.envName, who.tenant.id);
  return { ok: true, message: `Retracted: ${row.remoteId} is archived on your team graph.` };
}
