/**
 * ALI-1540: the gateway's share-request routes, parsed without trusting them.
 *
 * Built from `request` (the gateway client's own fetch wrapper: bearer, identity headers, error text) so there
 * is one HTTP path. Every call refuses a redirect: a 30x to another host would carry the bearer token and the
 * sealed request. Every answer is validated, and an answer that does not look right is an error, never a
 * default: a gateway that says something this CLI does not know is not asked to approve anything.
 *
 * Routes (the plan's Routes table; the gateway side is built separately, so these shapes are the contract):
 *   GET  /share-requests/config            -> { mode, pending_ttl_s, complete_ttl_s }   (404: an older gateway)
 *   POST /share-requests                   -> 201 { id (the SERVER's row id), user_code, expires_at }; 409 on a repeated envelope_id for this tenant and user
 *   GET  /share-requests/:id               -> { state, expires_at? }
 *   POST /share-requests/:id/cancel        -> any 2xx
 *   POST /share-requests/:id/complete      -> the /ingest/batch response shape
 */
import type { BatchResponse } from './wire.js';

export type ShareMode = 'off' | 'available' | 'required';
const MODES: readonly string[] = ['off', 'available', 'required'];

export interface ShareRequestsConfig { mode: ShareMode; pendingTtlS: number | null; completeTtlS: number | null }

export type RequestState = 'pending' | 'approved' | 'completing' | 'completed' | 'declined' | 'expired' | 'cancelled' | 'failed';
const STATES: readonly string[] = ['pending', 'approved', 'completing', 'completed', 'declined', 'expired', 'cancelled', 'failed'];

export interface StageBody {
  /** The CLI's own id for the sealed envelope (in its AAD). Unique per tenant and user; NOT the row's id. */
  envelope_id: string;
  kind: 'share' | 'confirm_team_text';
  /** iv || ciphertext || tag, base64. */
  envelope: string;
  payload_sha256: string;
  item_count: number;
  judgement_count: number;
  requester_label?: string;
  agent?: string;
}

export interface StagedRequest { id: string; userCode: string; expiresAt: string }
export interface ShareRequestStatus { state: RequestState; expiresAt: string | null }

export interface ShareRequestsApi {
  /** Null when the gateway has no such route (404): an older gateway, so the typed path applies. `signal` aborts the call (Ctrl-C). */
  shareRequestsConfig(signal?: AbortSignal): Promise<ShareRequestsConfig | null>;
  stageShareRequest(body: StageBody, signal?: AbortSignal): Promise<StagedRequest>;
  getShareRequest(id: string, signal?: AbortSignal): Promise<ShareRequestStatus>;
  cancelShareRequest(id: string): Promise<void>;
  completeShareRequest(id: string, payloadB64: string): Promise<BatchResponse>;
}

export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

type Requester = <T>(path: string, options?: Parameters<typeof fetch>[1] & { maxBytes?: number }) => Promise<T>;

/** Every call has a deadline and a size cap: a gateway that hangs or answers without end cannot hold this process. */
export const REQUEST_TIMEOUT_MS = 15_000;
export const COMPLETE_TIMEOUT_MS = 30_000;
const SMALL_ANSWER_BYTES = 64 * 1024;
const BATCH_ANSWER_BYTES = 2 * 1024 * 1024;

const bad = (what: string): Error => new Error(`The gateway answered the share request with something this CLI does not recognise (${what}), so nothing was done.`);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function idOf(id: string): string {
  if (!REQUEST_ID_RE.test(id)) throw new Error('That is not a share request id.');
  return id;
}

export function shareRequestMethods(request: Requester): ShareRequestsApi {
  const call = <T>(path: string, init: { method?: string; body?: string } = {}, o: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<T> => {
    const deadline = AbortSignal.timeout(o.timeoutMs ?? REQUEST_TIMEOUT_MS);
    return request<T>(path, { redirect: 'error', maxBytes: o.maxBytes ?? SMALL_ANSWER_BYTES, signal: o.signal ? AbortSignal.any([o.signal, deadline]) : deadline, ...init });
  };
  return {
    async shareRequestsConfig(signal) {
      let raw: unknown;
      try { raw = await call<unknown>('/share-requests/config', {}, { signal }); } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404) return null;
        throw e;
      }
      if (!isObj(raw) || typeof raw['mode'] !== 'string' || !MODES.includes(raw['mode'])) throw bad('the approval mode');
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
      return { mode: raw['mode'] as ShareMode, pendingTtlS: num(raw['pending_ttl_s']), completeTtlS: num(raw['complete_ttl_s']) };
    },
    async stageShareRequest(body, signal) {
      const raw = await call<unknown>('/share-requests', { method: 'POST', body: JSON.stringify(body) }, { signal });
      if (!isObj(raw) || typeof raw['id'] !== 'string' || typeof raw['user_code'] !== 'string' || typeof raw['expires_at'] !== 'string') throw bad('the staged request');
      // The row id is the server's. Every later route uses it, so it must be a well-formed UUID before it becomes a path.
      if (!REQUEST_ID_RE.test(raw['id'])) throw bad('the request id');
      if (!USER_CODE_RE.test(raw['user_code'])) throw bad('the code');
      if (Number.isNaN(Date.parse(raw['expires_at']))) throw bad('the expiry');
      return { id: raw['id'], userCode: raw['user_code'], expiresAt: raw['expires_at'] };
    },
    async getShareRequest(id, signal) {
      const raw = await call<unknown>(`/share-requests/${idOf(id)}`, {}, { signal });
      if (!isObj(raw) || typeof raw['state'] !== 'string' || !STATES.includes(raw['state'])) throw bad('the request state');
      const expires = typeof raw['expires_at'] === 'string' && !Number.isNaN(Date.parse(raw['expires_at'])) ? raw['expires_at'] : null;
      return { state: raw['state'] as RequestState, expiresAt: expires };
    },
    async cancelShareRequest(id) {
      await call(`/share-requests/${idOf(id)}/cancel`, { method: 'POST', body: '{}' });
    },
    async completeShareRequest(id, payloadB64) {
      const raw = await call<unknown>(`/share-requests/${idOf(id)}/complete`, { method: 'POST', body: JSON.stringify({ payload_b64: payloadB64 }) }, { timeoutMs: COMPLETE_TIMEOUT_MS, maxBytes: BATCH_ANSWER_BYTES });
      if (!isObj(raw)) throw bad('the completion');
      return raw as BatchResponse;
    },
  };
}
