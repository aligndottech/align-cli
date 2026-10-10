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
import { getLegacyPromotion, getPromotion, ledgerReady, listPromotions, markRetracted, type Promotion, type PromotionWrite, recordPromotion, recordPromotions } from './ledger.js';
import { visible } from './visible.js';
import { TEAM_TEXT_HASH_RE } from './envelope.js';
import type { ShareRequestsApi } from './requests-client.js';
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

export interface ShareClient extends ShareRequestsApi {
  whoami(): Promise<{ user: { email: string; id?: string }; tenant: { id: string; name: string } }>;
  shareBatch(items: Array<Record<string, unknown>>): Promise<BatchResponse>;
  getDecision(id: string): Promise<TeamDecision>;
  archiveDecision(id: string): Promise<void>;
}

export interface ShareContext {
  dbPath: string;
  envName: string;
  client: ShareClient;
  judge: Judge;
  /** This install's private share salt (see salt.ts): never sent anywhere, not the telemetry install id. */
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
  /** The signed-in user's id (from whoami), bound into a sealed request's AAD. Null when the gateway did not say. */
  userId: string | null;
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
  // The graph was just opened (which repairs an older v10); refuse BEFORE any request if the ledger is still not usable.
  if (!ledgerReady(ctx.dbPath)) throw new ShareError('Your local graph\'s record of shares is not in the expected shape, so nothing was sent. Run `align local status` once, or update the CLI.');

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
    // A live row with no stored key came from an earlier test build of this branch, whose key was derived another
    // way. Re-deriving it now could mint a SECOND team decision, so the share stops and names the way out.
    if (live && prior.clientKey === '') {
      throw new ShareError(`${visible(row.id)} was shared by an earlier build that did not record its key, so sharing it again could create a second copy.\n  Retract the old one, then share again: align share --retract ${visible(row.id)}`);
    }
    const p = buildSharePayload({
      row, judgements: mine, remoteIdOf, titleOf: (id) => titles.get(id) ?? null,
      // The key is minted ONCE and reused, so a twin fold (a new local id) cannot create a second team decision.
      clientKey: prior && prior.clientKey !== '' ? prior.clientKey : clientKeyFor(ctx.salt, row.id),
      salt: ctx.salt,
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
  return { payloads, dest, tenantId, userId: who.user.id ?? null, gatewayUrl: ctx.gatewayUrl, priors, already, secrets, preview: renderPreview(payloads, dest, { updates, legacy }) };
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
  /**
   * Browser approval (ALI-1540): the batch goes out through the gateway's completion of a request the person
   * approved, NOT through shareBatch. Called once per batch with phase 'share' (the caller already holds the
   * answer) and once more with phase 'confirm' for a re-post that waits on the team's text. Null means that
   * step was not approved (declined, expired, cancelled): nothing was posted for it.
   */
  post?: (batch: SharePayload[], phase: 'share' | 'confirm', confirm?: { remoteId: string; teamTextHash: string }) => Promise<BatchResponse | null>;
  /**
   * With `post`: whether the person can approve the team-text confirmation in this run. Absent, the judgements
   * that wait on it stay unconfirmed and the result says so (a person re-runs the share to finish that step).
   */
  confirmByApproval?: boolean;
}

async function postBatch(ctx: ShareContext, batch: SharePayload[], hooks: SendHooks, phase: 'share' | 'confirm' = 'share', confirm?: { remoteId: string; teamTextHash: string }): Promise<ItemOutcome[] | null> {
  const res = hooks.post ? await hooks.post(batch, phase, confirm) : await ctx.client.shareBatch(batch.map((p) => ({ ...p.item })));
  return res === null ? null : readOutcomes(batch.length, res);
}

/** The judgements the gateway reported as stored, by hash. A null report stores nothing we can name. */
function storedHashes(p: SharePayload, results: JudgementResult[] | null): string[] {
  if (results === null) return [];
  return p.shown.flatMap((s, i) => (results[i]?.ok === true ? [s.hash] : []));
}

interface Item {
  p: SharePayload;
  outcome: ItemOutcome;
  live: boolean;
  prior: Promotion | null;
  stored: Set<string>;
  warnings: string[];
  confirmPending: boolean;
  failures: Array<{ index: number; error: string }>;
}

/**
 * The ledger row an outcome implies, from the FIRST response alone, or null when nothing was written
 * (refused, unknown). Matched and skipped rows are `matched` (not ours to archive); an update of something
 * this machine never shared is treated the same way, with a warning.
 */
function initialRow(ctx: ShareContext, prep: Prepared, it: Item): PromotionWrite | null {
  const { p, outcome } = it;
  const base = { localId: p.localId, env: ctx.envName, tenantId: prep.tenantId, contentHash: p.fullHash, clientKey: p.item.client_key, sent: [...it.stored], confirmPending: it.confirmPending };
  switch (outcome.kind) {
    case 'created': return { ...base, remoteId: outcome.remoteId, matched: outcome.uncertain };
    case 'updated': return { ...base, remoteId: outcome.remoteId, matched: it.live ? it.prior!.matched : true };
    case 'matched': return { ...base, remoteId: outcome.remoteId, matched: true };
    case 'skipped': return { ...base, remoteId: outcome.remoteId, matched: true };
    default: return null;
  }
}

export async function send(ctx: ShareContext, prep: Prepared, hooks: SendHooks = {}): Promise<RowResult[]> {
  const results: RowResult[] = [];
  for (let at = 0; at < prep.payloads.length; at += SHARE_BATCH_ITEMS) {
    const batch = prep.payloads.slice(at, at + SHARE_BATCH_ITEMS);
    const outcomes = await postBatch(ctx, batch, hooks);
    if (outcomes === null) throw new ShareError('The share was not approved, so nothing was posted.');
    const items: Item[] = batch.map((p, k) => {
      const outcome = outcomes[k]!;
      const prior = prep.priors.get(p.localId) ?? null;
      const live = prior !== null && prior.retractedAt === null;
      const it: Item = { p, outcome, live, prior, stored: new Set(live ? prior.sent : []), warnings: [], confirmPending: false, failures: 'judgements' in outcome ? failedJudgements(outcome.judgements) : [] };
      if ('judgements' in outcome) for (const h of storedHashes(p, outcome.judgements)) it.stored.add(h);
      if ('judgements' in outcome && outcome.judgements === null && p.item.judgements.length > 0) {
        it.warnings.push(`this gateway did not report what happened to your ${p.item.judgements.map((j) => j.kind).join(', ')}: they were not stored as far as can be told, so they stay unsent here and your ratify was not stored by this gateway. Check your team graph.`);
      }
      if (outcome.kind === 'created' && outcome.uncertain) it.warnings.push('this gateway cannot tell new from existing (it is older than share matching), so this is recorded as not yours to retract.');
      if (outcome.kind === 'updated' && !live) it.warnings.push('the gateway answered this as an existing team decision, so it is recorded as not yours to retract.');
      if (outcome.kind === 'matched') it.confirmPending = outcome.needsConfirmation.length > 0;
      return it;
    });
    // Record EVERY item the first response named, in ONE write, before anything that can throw (the team-text
    // fetch, the confirmation re-post, a later batch): a 502 or a kill after this point cannot orphan a
    // decision that now exists on the team graph and is retractable only through this row.
    recordPromotions(ctx.dbPath, items.flatMap((it) => { const r = initialRow(ctx, prep, it); return r ? [r] : []; }));

    for (const it of items) {
      const { p, outcome } = it;
      if (outcome.kind === 'matched' && outcome.needsConfirmation.length > 0) {
        let team: TeamDecision | null = null;
        const hashOk = outcome.teamTextHash !== null && TEAM_TEXT_HASH_RE.test(outcome.teamTextHash);
        if (hooks.post && hooks.confirmByApproval && outcome.teamTextHash !== null && !hashOk) it.warnings.push('the gateway sent a team text hash this CLI does not recognise, so your ratify was not confirmed.');
        const byApproval = hooks.post !== undefined && hooks.confirmByApproval === true && hashOk;
        if (!byApproval && outcome.teamTextHash && hooks.confirmTeamText) team = await ctx.client.getDecision(outcome.remoteId).catch(() => null);
        if (team !== null && !('decision_json' in team)) {
          it.warnings.push('the team\'s full text could not be read from this gateway, so your ratify was not confirmed.');
          team = null;
        }
        const agreed = byApproval || (team !== null && hooks.confirmTeamText !== undefined && await hooks.confirmTeamText({ localId: p.localId, title: p.item.title, team }));
        if (agreed) {
          // Re-post ONLY what waited: a note or check verdict already stored must not be posted a second time.
          const need = new Set(outcome.needsConfirmation.map((n) => n.judgement_index));
          const waiting = p.shown.filter((_, i) => need.has(i));
          const again: SharePayload = { ...p, shown: waiting, item: { ...p.item, judgements: waiting.map((s) => ({ ...s.wire, confirm_team_text_hash: outcome.teamTextHash! })) } };
          const second = (await postBatch(ctx, [again], hooks, 'confirm', byApproval ? { remoteId: outcome.remoteId, teamTextHash: outcome.teamTextHash! } : undefined))?.[0];
          if (second === undefined) it.warnings.push('the confirmation of the team\'s text was not approved, so your ratify was not confirmed. Run the share again to try once more.');
          else if (second.kind === 'matched') {
            for (const h of storedHashes(again, second.judgements)) it.stored.add(h);
            it.failures = failedJudgements(second.judgements);
            it.confirmPending = it.failures.length > 0;
            const row = initialRow(ctx, prep, it);
            if (row) recordPromotion(ctx.dbPath, row);
          }
        }
      }
      if (outcome.kind === 'matched') it.failures = it.failures.filter((f) => f.error !== 'needs_confirmation' || it.confirmPending);
      results.push({ localId: p.localId, title: p.item.title, outcome, judgementFailures: it.failures, warnings: it.warnings });
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
