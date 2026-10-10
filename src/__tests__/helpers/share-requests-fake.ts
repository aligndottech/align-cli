/** Test-only: the share-request half of a ShareClient for a gateway that has no such route (an older one). */
import type { ShareRequestsApi } from '../../lib/share/requests-client.js';

const refuse = async (): Promise<never> => { throw new Error('this fake gateway has no share-request routes'); };

export const noShareRequests: ShareRequestsApi = {
  shareRequestsConfig: async () => null,
  stageShareRequest: refuse, getShareRequest: refuse, cancelShareRequest: refuse, completeShareRequest: refuse,
};

/** An approval config that is never reached by a typed-flow test. */
export const approvalDeps = { appUrl: 'https://app.test', label: 'test-box', sleep: async () => undefined, now: () => 0 };

import { randomUUID, webcrypto } from 'node:crypto';
import type { BatchResponse } from '../../lib/share/wire.js';
import type { ShareMode, StageBody } from '../../lib/share/requests-client.js';

/** What a browser does with an envelope and the key from the link: WebCrypto, independent of the CLI's own sealing code. */
export async function openInBrowserWay(envelopeB64: string, keyB64Url: string, bind: { envelopeId: string; tenantId: string; userId: string; kind: string }): Promise<Buffer> {
  const raw = Buffer.from(envelopeB64, 'base64');
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(keyB64Url, 'base64url'), 'AES-GCM', false, ['decrypt']);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: Buffer.from(`v1|${bind.envelopeId}|${bind.tenantId}|${bind.userId}|${bind.kind}`) },
    key, raw.subarray(12),
  );
  return Buffer.from(plain);
}

export const keyOf = (url: string): string => new URL(url).hash.replace(/^#k=/, '');
export const urlIn = (lines: readonly string[]): string => lines.map((l) => /Approve in your browser: (\S+)/.exec(l)?.[1]).find((u) => u !== undefined) ?? '';

export interface FakeRequests {
  api: ShareRequestsApi;
  mode: ShareMode | null;
  /** The states the next GETs return, in order; the last one repeats. */
  states: string[];
  staged: StageBody[];
  /** The server's own row id for each staged request, by envelope id (the CLI's id is not the row id). */
  rowIds: Map<string, string>;
  gets: number;
  cancels: string[];
  completes: Array<{ id: string; payloadB64: string }>;
  /** Everything every call carried, as one string: for "the key was never sent". */
  wire: string[];
  getError?: () => Error | undefined;
  cancelError?: Error;
  completeError?: Error;
  reply: (n: number, payload: Record<string, unknown>) => BatchResponse;
  /** Replies for later completes (a second approval), consumed in order before `reply`. */
  replies: BatchResponse[];
  /** Run when a poll happens, with the poll count: lets a test approve or abort at a chosen moment. */
  onGet?: (n: number) => void;
}

const okReply = (_n: number, payload: Record<string, unknown>): BatchResponse => {
  const decisions = payload['decisions'] as Array<{ judgements?: unknown[] }>;
  return {
    snapshots: decisions.map((_, i) => ({ id: `R${i}`, request_index: i, is_new: true })),
    judgements: decisions.map((d, i) => ({ request_index: i, decision_id: `R${i}`, results: (d.judgements ?? []).map(() => ({ ok: true, stored: true })) })),
  };
};

export function fakeRequests(init: Partial<Pick<FakeRequests, 'mode' | 'states'>> = {}): FakeRequests {
  const f: FakeRequests = {
    mode: init.mode === undefined ? 'available' : init.mode, states: init.states ?? ['approved'], staged: [], rowIds: new Map(), gets: 0, cancels: [], completes: [], wire: [], replies: [],
    reply: okReply,
    api: undefined as unknown as ShareRequestsApi,
  };
  f.api = {
    shareRequestsConfig: async () => (f.mode === null ? null : { mode: f.mode, pendingTtlS: 900, completeTtlS: 600 }),
    stageShareRequest: async (body) => {
      f.staged.push(body); f.wire.push(JSON.stringify(body));
      const rowId = randomUUID(); f.rowIds.set(body.envelope_id, rowId);
      return { id: rowId, userCode: 'KJ4M-9XQT', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    },
    getShareRequest: async (id) => {
      f.wire.push(`GET ${id}`);
      f.gets += 1;
      f.onGet?.(f.gets);
      const err = f.getError?.();
      if (err) throw err;
      const state = f.states.length > 1 ? f.states.shift()! : f.states[0]!;
      return { state: state as never, expiresAt: null };
    },
    cancelShareRequest: async (id) => { f.wire.push(`CANCEL ${id}`); f.cancels.push(id); if (f.cancelError) throw f.cancelError; },
    completeShareRequest: async (id, payloadB64) => {
      f.wire.push(JSON.stringify({ id, payloadB64 }));
      f.completes.push({ id, payloadB64 });
      if (f.completeError) throw f.completeError;
      const plain = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')) as { decisions: unknown[] };
      return f.replies.shift() ?? f.reply(plain.decisions.length, plain as never);
    },
  };
  return f;
}
