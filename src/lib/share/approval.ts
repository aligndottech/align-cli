/**
 * ALI-1540: the client side of an approval, as functions over an injected client, a clock and a sleep.
 *
 * stage   - make the request id, seal, send the ciphertext, check the answer is about THIS request.
 * poll    - ask the gateway what the person did, backing off, stopping at the expiry, stopping on Ctrl-C.
 * link    - build the approve URL. The key goes in the fragment ONLY, which a browser never sends.
 * complete - after (and only after) the gateway says approved, send the exact approved bytes.
 *
 * Nothing here can approve: the approve route refuses the CLI's token. A person does that in a browser.
 */
import { randomUUID } from 'node:crypto';
import { seal } from './envelope.js';
import type { RequestKind } from './envelope.js';
import type { ShareRequestsApi, StagedRequest } from './requests-client.js';
import { visible } from './visible.js';
import { ShareError } from './run.js';
import type { BatchResponse } from './wire.js';

/** Sleep that ends early when `signal` aborts (Ctrl-C), so a cancel is not delayed by a poll interval. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface StageInput {
  kind: RequestKind;
  plaintext: Buffer;
  tenantId: string;
  userId: string;
  itemCount: number;
  judgementCount: number;
  label: string;
  agent?: string;
}

/** `id` is the gateway's row id (every route and the link use it); `envelopeId` is the CLI's own, bound in the AAD. */
export interface Staged extends StagedRequest {
  envelopeId: string;
  keyB64Url: string;
  sha256: string;
  /** The exact plaintext, base64: what `complete` sends and what the gateway re-hashes. */
  bytesB64: string;
}

/** A machine label the person will read on the page as "a machine calling itself ...": printable, one line, at most 120 characters. */
export function cleanLabel(raw: string): string {
  return visible(raw).replace(/\s+/g, ' ').trim().slice(0, 120);
}

export async function stageRequest(client: Pick<ShareRequestsApi, 'stageShareRequest'>, input: StageInput, makeId: () => string = randomUUID): Promise<Staged> {
  const envelopeId = makeId();
  const sealed = seal(input.plaintext, { envelopeId, tenantId: input.tenantId, userId: input.userId, kind: input.kind });
  const label = cleanLabel(input.label);
  const res = await client.stageShareRequest({
    envelope_id: envelopeId, kind: input.kind, envelope: sealed.envelopeB64, payload_sha256: sealed.sha256,
    item_count: input.itemCount, judgement_count: input.judgementCount,
    ...(label ? { requester_label: label } : {}), ...(input.agent ? { agent: input.agent } : {}),
  });
  return { ...res, envelopeId, keyB64Url: sealed.keyB64Url, sha256: sealed.sha256, bytesB64: input.plaintext.toString('base64') };
}

/** The link the person opens. The key is in the fragment, never the path or query. */
export function approveUrl(appUrl: string, requestId: string, keyB64Url: string): string {
  return `${appUrl.replace(/\/+$/, '')}/share/approve/${requestId}#k=${keyB64Url}`;
}

export type Decision = 'approved' | 'declined' | 'expired' | 'cancelled' | 'failed' | 'aborted';

export interface PollDeps {
  client: Pick<ShareRequestsApi, 'getShareRequest'>;
  now: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export const POLL_START_MS = 2000;
export const POLL_MAX_MS = 5000;
export const POLL_GROWTH = 1.3;
/** Consecutive failed status reads before giving up. One blip is not a decision. */
export const POLL_MAX_FAILURES = 3;

/**
 * Poll until the person decides. The expiry is the gateway's own `expires_at`; at that moment the answer is read
 * ONE more time before calling it expired, because this machine's clock may run ahead of the gateway's and an
 * approval can land in the last second.
 */
export async function pollUntilDecided(id: string, expiresAt: string, deps: PollDeps): Promise<Decision> {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) throw new ShareError('The gateway gave this request no usable expiry, so it was not waited on.');
  let delay = POLL_START_MS;
  let failures = 0;
  for (;;) {
    if (deps.signal?.aborted) return 'aborted';
    const last = deps.now() >= deadline;
    try {
      const { state } = await deps.client.getShareRequest(id);
      failures = 0;
      switch (state) {
        case 'approved': return 'approved';
        case 'declined': case 'expired': case 'cancelled': case 'failed': return state;
        case 'pending': break;
        // completing and completed mean something other than this process acted on the request: not ours to wait on.
        default: throw new ShareError(`The request is already ${visible(state)} on the gateway, which this run did not do. Nothing more was sent from here.`);
      }
    } catch (e) {
      if (e instanceof ShareError) throw e;
      failures += 1;
      if (failures >= POLL_MAX_FAILURES) throw new ShareError(`Could not read the request's status ${POLL_MAX_FAILURES} times in a row (${visible((e as Error).message)}). It stays open until it expires; nothing is sent without your approval.`);
    }
    if (last) return 'expired';
    await deps.sleep(delay, deps.signal);
    delay = Math.min(Math.round(delay * POLL_GROWTH), POLL_MAX_MS);
  }
}

/** A completion that failed. `retryable` is true when no verdict came back (5xx, a dropped connection): the same bytes may be sent again. */
export class CompletionError extends ShareError {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'CompletionError'; }
}

/**
 * Send the approved bytes. The gateway re-hashes them against what the person approved, so a payload that
 * differs by one character is refused there. An error here is explained by status; a 5xx or a dropped
 * connection is an UNKNOWN outcome, not a failure, because the gateway may have finished before the answer got lost.
 */
export async function completeRequest(client: Pick<ShareRequestsApi, 'completeShareRequest'>, id: string, bytesB64: string): Promise<BatchResponse> {
  try {
    return await client.completeShareRequest(id, bytesB64);
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? 0;
    const msg = visible((e as Error).message);
    if (status === 410) throw new CompletionError('The approval was too old to use (it lasts 10 minutes). Nothing was sent. Run the share again.', false);
    if (status === 422) throw new CompletionError(`The gateway refused what was approved: ${msg}. Nothing was sent.`, false);
    if (status >= 400 && status < 500) throw new CompletionError(`The gateway would not complete it: ${msg}. Nothing was sent.`, false);
    throw new CompletionError(`The gateway did not say whether the share finished (${msg}). Check your team graph before sharing again; sharing again is safe, it will not make a second copy.`, true);
  }
}
