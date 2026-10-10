/**
 * ALI-1540: seal what a share would send, so the team server holds only ciphertext until a person approves.
 *
 * The CLI seals the exact plaintext bytes with AES-256-GCM under a random 32-byte key the server never sees:
 * the key travels only in the approve link's `#k=` fragment, which a browser does not send. The AAD is
 * `v1|<request id>|<tenant id>`, so a ciphertext swapped onto another request or workspace fails to open. The
 * request id is made HERE, before sealing, and sent with the request so the stored envelope is bound to the
 * id it lives under. The hash is over the plaintext bytes as sealed, never over a re-serialised object.
 *
 * Layout: iv (12) || ciphertext || tag (16). That is the order WebCrypto wants (it takes the tag appended to the
 * ciphertext), so the browser opens it with no reshaping (spike S1: parity with Node and real Chromium).
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { SharePayload } from './payload.js';
import { toBatchDecisions } from './payload.js';

/** The envelope column holds 262,144 bytes; IV and tag take 28 of them. */
export const MAX_ENVELOPE_BYTES = 262_144;
export const ENVELOPE_OVERHEAD_BYTES = 28;
export const MAX_PLAINTEXT_BYTES = MAX_ENVELOPE_BYTES - ENVELOPE_OVERHEAD_BYTES;

export class PlaintextTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`This share is ${bytes} bytes once sealed, over the ${MAX_PLAINTEXT_BYTES} byte limit for one approval.`);
    this.name = 'PlaintextTooLargeError';
  }
}

export interface Binding { requestId: string; tenantId: string }

export function aadFor(b: Binding): Buffer {
  return Buffer.from(`v1|${b.requestId}|${b.tenantId}`, 'utf8');
}

export interface Sealed {
  /** iv || ciphertext || tag, standard base64: what the server stores. */
  envelopeB64: string;
  /** 32 random bytes, 43 base64url characters: goes ONLY in the link's fragment and the local pending file. */
  keyB64Url: string;
  /** Lowercase hex SHA-256 of the plaintext bytes. */
  sha256: string;
}

export function seal(plaintext: Buffer, bind: Binding): Sealed {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new PlaintextTooLargeError(plaintext.length);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(bind));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return { envelopeB64: envelope.toString('base64'), keyB64Url: key.toString('base64url'), sha256: createHash('sha256').update(plaintext).digest('hex') };
}

export type RequestKind = 'share' | 'confirm_team_text';

export interface PlaintextInput {
  kind: RequestKind;
  tenantId: string;
  gatewayUrl: string;
  payloads: readonly SharePayload[];
  /** For kind confirm_team_text: the team decision whose text the person confirms, and the hash the judgements carry. */
  confirm?: { remoteId: string; teamTextHash: string };
}

/**
 * The plaintext (v1). `decisions` is the exact /ingest/batch decisions array; `display` is labels only (counterpart
 * titles, who relayed each judgement, what stays local), so a lying display can mislabel a counterpart but cannot
 * hide or add text that is sent. `tenant_id` and `gateway_url` let the page refuse a link aimed elsewhere.
 */
export function buildPlaintext(input: PlaintextInput): Buffer {
  const body = {
    v: 1,
    kind: input.kind,
    tenant_id: input.tenantId,
    gateway_url: input.gatewayUrl,
    ...(input.confirm ? { confirm: { decision_id: input.confirm.remoteId, team_text_hash: input.confirm.teamTextHash } } : {}),
    decisions: toBatchDecisions(input.payloads.map((p) => ({ ...p.item }))),
    display: input.payloads.map((p) => ({
      judgements: p.shown.map((s) => ({ via: s.via, agent: s.agentId, counterpart_title: s.counterpartTitle })),
      left_local: p.leftLocal.map((l) => ({ kind: l.kind, why: l.why, counterpart_title: l.counterpartTitle })),
    })),
  };
  return Buffer.from(JSON.stringify(body), 'utf8');
}
