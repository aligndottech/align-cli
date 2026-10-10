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
import { getLegacyPromotion, getPromotion, listPromotions, markRetracted, type Promotion, recordPromotion } from './ledger.js';
import { visible } from './visible.js';
import { buildSharePayload, clientKeyFor, type SharePayload } from './payload.js';
import { type Destination, renderPreview } from './preview.js';
import { scanForSecrets, scanHiddenText, scanSourceUrl, type SecretFinding } from './secret-scan.js';
import { type BatchResponse, failedJudgements, type ItemOutcome, type JudgementResult, readOutcomes } from './wire.js';

export interface TeamDecision {
  title?: string;
  summary?: string;
  /** The decision's AI payload: the server's team-text hash also covers its statements, Gherkin and acceptance criteria. */
  decision_json?: { ai?: { decisions?: unknown; gherkin?: unknown; acceptance_criteria?: unknown } } | null;
}

export interface ShareClient {
  whoami(): Promise<{ user: { email: string }; tenant: { id: string; name: string } }>;
  shareBatch(items: Array<Record<string, unknown>>): Promise<BatchResponse>;
  getDecision(id: string): Promise<TeamDecision>;
  archiveDecision(id: string): Promise<void>;
}

export interface ShareContext {
  dbPath: string;
  envName: string;
  client: ShareClient;
  judge: Judge;
  /** This install's secret salt for the opaque client_key (the install id the CLI already keeps). */
  salt: string;
  /** Where the share goes. Shown whenever it is not the environment's default, and bound into a confirmation code. */
  gatewayUrl: string;
  /** The default gateway URL for this environment, to tell an override from the norm. */
  defaultGatewayUrl: string;
}

export class ShareError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = 'ShareError'; }
}

export interface Prepared {
  payloads: SharePayload[];
  dest: Destination;
  tenantId: string;
  gatewayUrl: string;
  /** What this machine knew of each payload before: its ledger row, if any (live or retracted). */
  priors: Map<string, Promotion | null>;
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
  const dest: Destination = {
    workspace: who.tenant.name, env: ctx.envName, email: who.user.email,
    ...(ctx.gatewayUrl !== ctx.defaultGatewayUrl ? { gateway: ctx.gatewayUrl } : {}),
  };
  const rows: DecisionRow[] = [];
  const db = createLocalDb(ctx.dbPath);
  try {
    for (const id of ids) {
      const row = db.getDecisionById(id);
      if (!row) throw new ShareError(`No decision ${visible(id)} in your local graph. \`align decisions list\` shows what is there.`);
      if (!row.ratifiedAt) throw new ShareError(`${visible(id)} has not been ratified, so it stays a claim on this machine.\n  A human stands behind it first: align ratify ${visible(id)}`);
      rows.push(row);
    }
  } finally { db.close(); }

  const shared = listPromotions(ctx.dbPath, ctx.envName, tenantId);
  const remoteIdOf = (id: string) => shared.get(id)?.remoteId;
  const payloads: SharePayload[] = [];
  const priors = new Map<string, Promotion | null>();
  const already: Prepared['already'] = [];
  const secrets: Prepared['secrets'] = [];
  const updates = new Set<string>();
  const legacy = new Set<string>();
  for (const row of rows) {
    const mine = listJudgements(ctx.dbPath, ctx.judge.judgeId, row.id);
    const others = [...new Set(mine.flatMap((j) => [j.decision_id, j.counterpart_id]).filter((x): x is string => x !== null && x !== row.id))];
    const titles = existingTitles(ctx.dbPath, others);
    const prior = getPromotion(ctx.dbPath, row.id, ctx.envName, tenantId);
    priors.set(row.id, prior);
    const live = prior !== null && prior.retractedAt === null;
    const p = buildSharePayload({
      row, judgements: mine, remoteIdOf, titleOf: (id) => titles.get(id) ?? null,
      // The key is minted ONCE and reused, so a twin fold (a new local id) cannot create a second team decision.
      clientKey: prior && prior.clientKey !== '' ? prior.clientKey : clientKeyFor(ctx.salt, row.id),
      alreadySent: new Set(live ? prior.sent : []),
    });
    let note = 0;
    const fields = [
      { field: 'title', text: p.item.title }, { field: 'summary', text: p.item.summary }, { field: 'platform', text: p.item.platform },
      ...p.item.judgements.map((j) => ({ field: j.kind === 'note' ? `note ${++note}` : j.kind, text: j.note })),
    ];
    for (const f of [...scanForSecrets(fields), ...scanHiddenText([...fields, { field: 'raw_text', text: p.item.raw_text }, { field: 'source_url', text: p.item.source_url }])]) secrets.push({ ...f, localId: row.id });
    for (const f of scanSourceUrl(p.item.source_url)) secrets.push({ ...f, localId: row.id });
    if (live) {
      if (prior.contentHash === p.fullHash && p.item.judgements.length === 0 && !prior.confirmPending) {
        already.push({ localId: row.id, title: row.title, remoteId: prior.remoteId });
        continue;
      }
      updates.add(row.id);
    } else if (!prior && getLegacyPromotion(ctx.dbPath, row.id, ctx.envName)) legacy.add(row.id);
    payloads.push(p);
  }
  return { payloads, dest, tenantId, gatewayUrl: ctx.gatewayUrl, priors, already, secrets, preview: renderPreview(payloads, dest, { updates, legacy }) };
}

/** The refusal text: where, which kind, never the value. */
export function secretRefusal(secrets: Prepared['secrets']): string {
  const lines = secrets.map((s) => `  ${visible(s.localId)}: ${visible(s.field)} ${s.placeholder === '<HIDDEN_TEXT>' ? 'contains hidden tag characters (invisible text)' : `looks like ${s.placeholder}`}`);
  return `Nothing was sent: part of what would be shared looks like a credential or holds hidden text.\n${lines.join('\n')}\n  Edit it out of the decision, then share again.`;
}

export type RowResult = {
  localId: string; title: string; outcome: ItemOutcome;
  judgementFailures: Array<{ index: number; error: string }>;
  /** Things the person must know that are not failures (an older gateway, a share treated as not yours to retract). */
  warnings: string[];
};

export interface SendHooks {
  /** A matched share whose ratify/supersede wait on the team's text: show it, return whether the person agrees. */
  confirmTeamText?: (info: { localId: string; title: string; team: TeamDecision }) => Promise<boolean>;
}

async function postBatch(ctx: ShareContext, batch: SharePayload[]): Promise<ItemOutcome[]> {
  const res = await ctx.client.shareBatch(batch.map((p) => ({ ...p.item })));
  return readOutcomes(batch.length, res);
}

/** The judgements the gateway reported as stored, by hash. A null report stores nothing we can name. */
function storedHashes(p: SharePayload, results: JudgementResult[] | null): string[] {
  if (results === null) return [];
  return p.shown.flatMap((s, i) => (results[i]?.ok === true ? [s.hash] : []));
}

export async function send(ctx: ShareContext, prep: Prepared, hooks: SendHooks = {}): Promise<RowResult[]> {
  const results: RowResult[] = [];
  for (let at = 0; at < prep.payloads.length; at += SHARE_BATCH_ITEMS) {
    const batch = prep.payloads.slice(at, at + SHARE_BATCH_ITEMS);
    const outcomes = await postBatch(ctx, batch);
    for (const [k, p] of batch.entries()) {
      const outcome = outcomes[k]!;
      const prior = prep.priors.get(p.localId) ?? null;
      const live = prior !== null && prior.retractedAt === null;
      const stored = new Set(live ? prior.sent : []);
      const warnings: string[] = [];
      const note = (reports: JudgementResult[] | null, forPayload: SharePayload) => { for (const h of storedHashes(forPayload, reports)) stored.add(h); };
      let confirmPending = false;
      let failures = 'judgements' in outcome ? failedJudgements(outcome.judgements) : [];

      if ('judgements' in outcome && outcome.judgements === null && p.item.judgements.length > 0) {
        warnings.push(`this gateway did not report what happened to your ${p.item.judgements.map((j) => j.kind).join(', ')}: they were not stored as far as can be told, so they stay unsent here and your ratify was not stored by this gateway. Check your team graph.`);
      }
      if (outcome.kind === 'matched') {
        note(outcome.judgements, p);
        if (outcome.needsConfirmation.length > 0) {
          confirmPending = true;
          let team: TeamDecision | null = null;
          if (outcome.teamTextHash && hooks.confirmTeamText) team = await ctx.client.getDecision(outcome.remoteId).catch(() => null);
          if (team !== null && !('decision_json' in team)) {
            warnings.push('the team\'s full text could not be read from this gateway, so your ratify was not confirmed.');
            team = null;
          }
          const agreed = team !== null && await hooks.confirmTeamText!({ localId: p.localId, title: p.item.title, team });
          if (agreed) {
            // Re-post ONLY what waited: a note or check verdict already stored must not be posted a second time.
            const need = new Set(outcome.needsConfirmation.map((n) => n.judgement_index));
            const hash = outcome.teamTextHash;
            const waiting = p.shown.filter((_, i) => need.has(i));
            const again: SharePayload = { ...p, shown: waiting, item: { ...p.item, judgements: waiting.map((s) => ({ ...s.wire, confirm_team_text_hash: hash! })) } };
            const second = (await postBatch(ctx, [again]))[0]!;
            if (second.kind === 'matched') {
              note(second.judgements, again);
              const left = failedJudgements(second.judgements);
              confirmPending = left.length > 0;
              failures = left;
            }
          }
        }
        failures = failures.filter((f) => f.error !== 'needs_confirmation' || confirmPending);
      } else if ('judgements' in outcome) {
        note(outcome.judgements, p);
      }

      results.push({ localId: p.localId, title: p.item.title, outcome, judgementFailures: failures, warnings });
      const base = { localId: p.localId, env: ctx.envName, tenantId: prep.tenantId, contentHash: p.fullHash, clientKey: p.item.client_key, sent: [...stored], confirmPending };
      if (outcome.kind === 'created') {
        recordPromotion(ctx.dbPath, { ...base, remoteId: outcome.remoteId, matched: false });
      } else if (outcome.kind === 'updated') {
        // An update of a decision this machine never shared: a gateway without share matching reuses the team's
        // row at that source. It is not ours to archive, so it is recorded as matched, and the person is told.
        if (!live) warnings.push('the gateway answered this as an existing team decision, so it is recorded as not yours to retract.');
        recordPromotion(ctx.dbPath, { ...base, remoteId: outcome.remoteId, matched: live ? prior.matched : true });
      } else if (outcome.kind === 'matched') {
        // Recorded once the judgements that need no confirmation are stored; the confirmation is tracked separately.
        recordPromotion(ctx.dbPath, { ...base, remoteId: outcome.remoteId, matched: true });
      }
    }
  }
  return results;
}

/** Every field the server's team-text hash covers, so what the person confirms is what the hash pins. */
export function renderTeamText(team: TeamDecision): string {
  const ai = team.decision_json?.ai ?? {};
  const show = (v: unknown): string => (v === undefined || v === null ? '(none)' : typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : JSON.stringify(v));
  const block = (label: string, v: unknown) => `  ${label}:\n${visible(show(v), { keepNewline: true }).split('\n').map((l) => `    ${l}`).join('\n')}`;
  return [
    block('Title', team.title ?? ''), block('Summary', team.summary ?? ''), block('Decisions', ai.decisions),
    block('Gherkin', ai.gherkin), block('Acceptance criteria', ai.acceptance_criteria),
  ].join('\n');
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
        case 'created': return o.ambiguous ? `shared as new (several team decisions share this source, so it was not matched): ${visible(o.remoteId)}` : `created: ${visible(o.remoteId)}`;
        case 'updated': return `updated: ${visible(o.remoteId)}`;
        case 'matched': return `matched an existing team decision (${visible(o.remoteId)}); your judgements were added, its text is untouched`;
        case 'skipped': return `left alone (${visible(o.reason)}): ${visible(o.remoteId)}`;
        case 'refused': return `refused by the server (${visible(o.reason)})`;
        case 'unknown': return 'the server did not say what happened to it; check your team graph before sharing again';
      }
    })();
    lines.push(`  ${visible(r.title)}\n    ${head}`);
    for (const w of r.warnings) lines.push(`    note: ${visible(w)}`);
    for (const f of r.judgementFailures) lines.push(`    judgement ${f.index + 1} not stored: ${FAIL_TEXT[f.error] ?? visible(f.error)}`);
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
