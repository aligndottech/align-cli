/**
 * ALI-1540: `align share` when the person approves in a browser instead of typing y.
 *
 * For each request (at most SHARE_BATCH_ITEMS decisions, and small enough to seal): stage it, print the link and the
 * code, wait, and when the gateway says the person approved, send the approved bytes. The link carries the key in
 * its `#k=` fragment; this module prints it to the terminal the person is at and keeps it nowhere else (the MCP
 * path stores it 0600 in the pending directory; this one holds it in memory).
 *
 * What a run from inside an agent can do here: stage and wait. Its own CLI token cannot approve: the gateway
 * refuses it on the approve route. That is why this path, unlike the typed one, is allowed when ALIGN_WRAPPED is set. It is
 * not a lock: SECURITY.md lists how an agent can still obtain a session.
 */
import { approveUrl, completeRequest, CompletionError, type PollDeps, pollUntilDecided, stageRequest } from './approval.js';
import { buildPlaintext, MAX_PLAINTEXT_BYTES, type RequestKind } from './envelope.js';
import type { SharePayload } from './payload.js';
import { type Prepared, renderResults, send, type SendHooks, SHARE_BATCH_ITEMS, type ShareContext, ShareError } from './run.js';
import type { ShareRequestsApi } from './requests-client.js';
import type { BatchResponse } from './wire.js';
import { visible } from './visible.js';

export interface BrowserFlowDeps extends Omit<PollDeps, 'client'> {
  client: ShareRequestsApi;
  appUrl: string;
  /** This machine's label, shown on the page as client-claimed. */
  label: string;
  agent?: string;
  /** Try to open the link here. The link is printed either way. */
  openUrl?: (url: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Split into requests of at most SHARE_BATCH_ITEMS decisions that each seal under the size cap. */
export function groupForApproval(payloads: readonly SharePayload[], to: { tenantId: string; userId: string; gatewayUrl: string }): SharePayload[][] {
  const size = (g: readonly SharePayload[]): number => buildPlaintext({ kind: 'share', ...to, payloads: g }).length;
  // A matched share is followed by a SECOND request (confirm_team_text) for the same item, which carries the `confirm` block and a
  // 64-character hash on every judgement. Size an item by the larger of the two, so the second request cannot be too big after the first landed.
  const confirmSize = (p: SharePayload): number => {
    const withHash: SharePayload = { ...p, item: { ...p.item, judgements: p.item.judgements.map((j) => ({ ...j, confirm_team_text_hash: 'f'.repeat(64) })) } };
    return buildPlaintext({ kind: 'confirm_team_text', ...to, payloads: [withHash], confirm: { remoteId: 'f'.repeat(64), teamTextHash: 'f'.repeat(64) } }).length;
  };
  const groups: SharePayload[][] = [];
  let cur: SharePayload[] = [];
  for (const p of payloads) {
    if (Math.max(size([p]), confirmSize(p)) > MAX_PLAINTEXT_BYTES) throw new ShareError(`"${visible(p.item.title)}" is too large to approve in one request (${Math.max(size([p]), confirmSize(p))} bytes sealed, the limit is ${MAX_PLAINTEXT_BYTES}). Nothing was sent. Shorten its text or its notes, then share again.`);
    if (cur.length > 0 && (cur.length >= SHARE_BATCH_ITEMS || size([...cur, p]) > MAX_PLAINTEXT_BYTES)) { groups.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export type StepResult = { ok: true; response: BatchResponse } | { ok: false; exit: number };

const minutesLeft = (expiresAt: string, now: number): number => Math.max(1, Math.round((Date.parse(expiresAt) - now) / 60000));

/** One request, end to end: stage, show the link, wait, and send the approved bytes. Prints what happened. */
export async function approveOne(
  d: BrowserFlowDeps,
  to: { tenantId: string; userId: string; gatewayUrl: string },
  spec: { kind: RequestKind; payloads: readonly SharePayload[]; confirm?: { remoteId: string; teamTextHash: string }; heading?: string; tail?: string },
): Promise<StepResult> {
  // What may be said about this step: for the first request nothing has been sent; for a confirmation or a later request, something already was.
  const tail = spec.tail ?? 'Nothing was sent.';
  if (d.signal?.aborted) { d.err(`Cancelled before it was staged. ${tail}`); return { ok: false, exit: 130 }; }
  const plaintext = buildPlaintext({ kind: spec.kind, ...to, payloads: spec.payloads, ...(spec.confirm ? { confirm: spec.confirm } : {}) });
  const staged = await stageRequest(d.client, {
    kind: spec.kind, plaintext, tenantId: to.tenantId, userId: to.userId,
    itemCount: spec.payloads.length, judgementCount: spec.payloads.reduce((n, p) => n + p.item.judgements.length, 0),
    label: d.label, ...(d.agent ? { agent: d.agent } : {}),
  }, undefined, d.signal);
  const url = approveUrl(d.appUrl, staged.id, staged.keyB64Url);
  if (spec.heading) d.out(spec.heading);
  d.out(`Approve in your browser: ${url}`);
  d.out(`Code: ${staged.userCode}  (the page shows the same code: check they match before you approve)`);
  d.out(`The link opens on any device where you are signed in to Align. It expires in ${minutesLeft(staged.expiresAt, d.now())} minutes. Nothing is sent until you approve.`);
  if (d.openUrl && !(await d.openUrl(url))) d.out('Could not open a browser here. Open the link above yourself.');
  d.out('Waiting for your approval. Ctrl-C cancels the request.');

  const decision = await pollUntilDecided(staged.id, staged.expiresAt, d);
  switch (decision) {
    case 'approved': break;
    case 'declined': d.out(`Declined in your browser. ${tail}`); return { ok: false, exit: 0 };
    case 'expired': d.err(`The request expired before it was approved. ${tail} Run the share again to start a new one.`); return { ok: false, exit: 1 };
    case 'cancelled': d.err(`The request was cancelled. ${tail}`); return { ok: false, exit: 1 };
    case 'failed': d.err(`The gateway marked the request as failed. ${tail} Run the share again.`); return { ok: false, exit: 1 };
    case 'aborted': {
      const cancelled = await d.client.cancelShareRequest(staged.id).then(() => true, () => false);
      d.err(cancelled
        ? `Cancelled the request. ${tail}`
        : 'Could not reach the gateway to cancel. The request expires on its own, and nothing can be sent from it: this run is the only thing that holds the means to finish it, and it has stopped.');
      return { ok: false, exit: 130 };
    }
  }
  d.out('Approved in your browser. Sending...');
  return { ok: true, response: await completeRequest(d.client, staged.id, staged.bytesB64) };
}

/**
 * The hooks that make `send` use the approvals: the first post of a group is the completion already in hand, and a
 * matched share that waits on the team's text asks for a SECOND approval (kind confirm_team_text), whose page shows
 * the team's text and refuses when its hash is not the one carried here.
 */
export function approvalHooks(d: BrowserFlowDeps, to: { tenantId: string; userId: string; gatewayUrl: string }, firstResponse: BatchResponse): SendHooks {
  let first = true;
  return {
    confirmByApproval: true,
    post: async (batch, phase, confirm) => {
      if (phase === 'share') {
        if (!first) throw new ShareError('Internal error: a group was posted twice.');
        first = false;
        return firstResponse;
      }
      d.out('\nYour ratification would sit on the team\'s existing text, so that needs its own approval.');
      const tail = 'The share itself already went through; your ratify is not confirmed. Run the share again to retry.';
      try {
        const step = await approveOne(d, to, { kind: 'confirm_team_text', payloads: batch, tail, ...(confirm ? { confirm } : {}) });
        return step.ok ? step.response : null;
      } catch (e) {
        // The first request already landed and is recorded: a failure here (the server's live-request cap, three failed reads, a
        // completion with no verdict) must not turn the run into a report that nothing happened.
        const why = e instanceof CompletionError ? (e.sent === 'maybe' ? 'the gateway did not say whether it finished; check your team graph' : 'the gateway refused it') : visible((e as Error).message);
        d.err(`The confirmation of the team's text did not finish (${why}). ${tail}`);
        return null;
      }
    },
  };
}

/**
 * Run every group through approval and `send`, printing each group's results as soon as they are known (a later
 * group that fails must not hide an earlier one that landed). Stops at the first group that is not approved.
 * Returns the exit code.
 */
export async function runBrowserShare(ctx: ShareContext, prep: Prepared, d: BrowserFlowDeps): Promise<number> {
  if (prep.userId === null) throw new ShareError('The gateway did not say who you are signed in as, so a request cannot be sealed to you. Nothing was staged. Run: align login');
  const to = { tenantId: prep.tenantId, userId: prep.userId, gatewayUrl: prep.gatewayUrl };
  const groups = groupForApproval(prep.payloads, to);
  let failed = false;
  let landed = 0;
  for (const [i, group] of groups.entries()) {
    const heading = groups.length > 1 ? `\nRequest ${i + 1} of ${groups.length} (${group.length} decision${group.length === 1 ? '' : 's'}):` : undefined;
    let step: StepResult;
    try {
      step = await approveOne(d, to, { kind: 'share', payloads: group, ...(heading ? { heading } : {}), ...(landed ? { tail: 'Nothing more was sent (the earlier requests in this run were).' } : {}) });
    } catch (e) {
      if (landed === 0) throw e;
      // Earlier requests are on the team graph and printed above: say this one failed, not that the run sent nothing.
      throw new ShareError(`${(e as Error).message} (That is about this request only: ${landed} earlier request${landed === 1 ? ' was' : 's were'} sent, see above.)`);
    }
    if (!step.ok) return failed ? 1 : step.exit;
    landed += 1;
    let rows;
    try {
      rows = await send(ctx, { ...prep, payloads: group }, approvalHooks(d, to, step.response));
    } catch (e) {
      d.err(`The gateway completed this request, so it is on your team graph, but this run could not finish recording it (${visible((e as Error).message)}). \`align share --retract\` may not find it until you share the same decision again (that is safe: it will not make a second copy).`);
      return 1;
    }
    d.out(`\n${renderResults(rows)}`);
    if (rows.some((r) => r.outcome.kind === 'refused' || r.outcome.kind === 'unknown')) failed = true;
  }
  return failed ? 1 : 0;
}
