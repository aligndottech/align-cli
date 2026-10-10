/**
 * ALI-1540: `align share` when the person approves in a browser instead of typing y.
 *
 * For each request (at most SHARE_BATCH_ITEMS decisions, and small enough to seal): stage it, print the link and the
 * code, wait, and when the gateway says the person approved, send the approved bytes. The link carries the key in
 * its `#k=` fragment; this module prints it to the terminal the person is at and keeps it nowhere else (the MCP
 * path stores it 0600 in the pending directory; this one holds it in memory).
 *
 * What a run from inside an agent can do here: stage and wait. It cannot approve: the gateway refuses the CLI's
 * token on the approve route. That is why this path, unlike the typed one, is allowed when ALIGN_WRAPPED is set.
 */
import { approveUrl, completeRequest, type PollDeps, pollUntilDecided, stageRequest } from './approval.js';
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
export function groupForApproval(payloads: readonly SharePayload[], to: { tenantId: string; gatewayUrl: string }): SharePayload[][] {
  const size = (g: readonly SharePayload[]): number => buildPlaintext({ kind: 'share', ...to, payloads: g }).length;
  const groups: SharePayload[][] = [];
  let cur: SharePayload[] = [];
  for (const p of payloads) {
    if (size([p]) > MAX_PLAINTEXT_BYTES) throw new ShareError(`"${visible(p.item.title)}" is too large to approve in one request (${size([p])} bytes sealed, the limit is ${MAX_PLAINTEXT_BYTES}). Nothing was sent. Shorten its text or its notes, then share again.`);
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
  to: { tenantId: string; gatewayUrl: string },
  spec: { kind: RequestKind; payloads: readonly SharePayload[]; confirm?: { remoteId: string; teamTextHash: string }; heading?: string },
): Promise<StepResult> {
  const plaintext = buildPlaintext({ kind: spec.kind, ...to, payloads: spec.payloads, ...(spec.confirm ? { confirm: spec.confirm } : {}) });
  const staged = await stageRequest(d.client, {
    kind: spec.kind, plaintext, tenantId: to.tenantId,
    itemCount: spec.payloads.length, judgementCount: spec.payloads.reduce((n, p) => n + p.item.judgements.length, 0),
    label: d.label, ...(d.agent ? { agent: d.agent } : {}),
  });
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
    case 'declined': d.out('Declined in your browser. Nothing was sent.'); return { ok: false, exit: 0 };
    case 'expired': d.err('The request expired before it was approved. Nothing was sent. Run the share again to start a new one.'); return { ok: false, exit: 1 };
    case 'cancelled': d.err('The request was cancelled. Nothing was sent.'); return { ok: false, exit: 1 };
    case 'failed': d.err('The gateway marked the request as failed. Nothing was sent. Run the share again.'); return { ok: false, exit: 1 };
    case 'aborted': {
      const cancelled = await d.client.cancelShareRequest(staged.id).then(() => true, () => false);
      d.err(cancelled
        ? 'Cancelled the request. Nothing was sent.'
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
export function approvalHooks(d: BrowserFlowDeps, to: { tenantId: string; gatewayUrl: string }, firstResponse: BatchResponse): SendHooks {
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
      const step = await approveOne(d, to, { kind: 'confirm_team_text', payloads: batch, ...(confirm ? { confirm } : {}) });
      return step.ok ? step.response : null;
    },
  };
}

/**
 * Run every group through approval and `send`, printing each group's results as soon as they are known (a later
 * group that fails must not hide an earlier one that landed). Stops at the first group that is not approved.
 * Returns the exit code.
 */
export async function runBrowserShare(ctx: ShareContext, prep: Prepared, d: BrowserFlowDeps): Promise<number> {
  const to = { tenantId: prep.tenantId, gatewayUrl: prep.gatewayUrl };
  const groups = groupForApproval(prep.payloads, to);
  let failed = false;
  for (const [i, group] of groups.entries()) {
    const heading = groups.length > 1 ? `\nRequest ${i + 1} of ${groups.length} (${group.length} decision${group.length === 1 ? '' : 's'}):` : undefined;
    const step = await approveOne(d, to, { kind: 'share', payloads: group, ...(heading ? { heading } : {}) });
    if (!step.ok) return failed ? 1 : step.exit;
    const rows = await send(ctx, { ...prep, payloads: group }, approvalHooks(d, to, step.response));
    d.out(`\n${renderResults(rows)}`);
    if (rows.some((r) => r.outcome.kind === 'refused' || r.outcome.kind === 'unknown')) failed = true;
  }
  return failed ? 1 : 0;
}
