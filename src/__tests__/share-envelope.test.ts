import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aadFor, buildPlaintext, ENVELOPE_OVERHEAD_BYTES, MAX_ENVELOPE_BYTES, MAX_PLAINTEXT_BYTES, PlaintextTooLargeError, seal } from '../lib/share/envelope.js';
import type { SharePayload } from '../lib/share/payload.js';
import { openInBrowserWay } from './helpers/share-requests-fake.js';

/**
 * ALI-1540 Test List, the sealed envelope:
 * - A browser's WebCrypto (not our own code) opens what seal made, byte for byte, and the hash is over those bytes.
 * - The AAD binds request id AND tenant: either one wrong, a flipped byte, or a wrong key fails to open.
 * - The cap is 262,116 plaintext bytes: that size seals (envelope exactly 262,144), one more byte is refused before anything is staged.
 * - The key never appears in the envelope or the plaintext; two seals of the same bytes differ.
 * - The plaintext carries the exact /ingest/batch decisions (created_at renamed to decided_at once) and labels-only display.
 */
const ID = '0b9f3c1e-5d2a-4f8e-9a77-3c1d2e4f5a6b';
const OTHER_ID = '1b9f3c1e-5d2a-4f8e-9a77-3c1d2e4f5a6b';
const T = 'tenant-AUTH';
const U = 'user-1';
const B = { envelopeId: ID, tenantId: T, userId: U, kind: 'share' as const };
const bytes = Buffer.from('{"v":1,"note":"café ✓"}', 'utf8');

describe('seal', () => {
  it('opens in WebCrypto under the right key, id and tenant, and the hash is over the exact bytes', async () => {
    const s = seal(bytes, B);
    const opened = await openInBrowserWay(s.envelopeB64, s.keyB64Url, B);
    expect(opened.equals(bytes)).toBe(true);
    expect(s.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // Hashing bytes, not objects: the same data re-serialised in another key order is different bytes and a different hash.
    const reordered = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(bytes.toString())).reverse())), 'utf8');
    expect(seal(reordered, B).sha256).not.toBe(s.sha256);
  });
  it('is bound to the envelope id, tenant, user and kind: any one wrong fails, and so do a wrong key and a flipped byte', async () => {
    const s = seal(bytes, B);
    await expect(openInBrowserWay(s.envelopeB64, s.keyB64Url, { ...B, envelopeId: OTHER_ID })).rejects.toThrow();
    await expect(openInBrowserWay(s.envelopeB64, s.keyB64Url, { ...B, tenantId: 'tenant-FOREIGN' })).rejects.toThrow();
    await expect(openInBrowserWay(s.envelopeB64, seal(bytes, B).keyB64Url, ID, T)).rejects.toThrow();
    await expect(openInBrowserWay(s.envelopeB64, s.keyB64Url, { ...B, userId: 'user-2' })).rejects.toThrow();
    await expect(openInBrowserWay(s.envelopeB64, s.keyB64Url, { ...B, kind: 'confirm_team_text' as never })).rejects.toThrow();
    const raw = Buffer.from(s.envelopeB64, 'base64'); raw[20] = raw[20]! ^ 1;
    await expect(openInBrowserWay(raw.toString('base64'), s.keyB64Url, B)).rejects.toThrow();
  });
  it('builds the AAD as v1|<envelope id>|<tenant id>|<user id>|<kind>', () => {
    expect(aadFor(B).toString('utf8')).toBe(`v1|${ID}|${T}|${U}|share`);
  });
  it('seals exactly 262,116 plaintext bytes into a 262,144 byte envelope, and refuses one byte more before sealing', async () => {
    expect(MAX_PLAINTEXT_BYTES).toBe(262_116);
    expect(MAX_PLAINTEXT_BYTES + ENVELOPE_OVERHEAD_BYTES).toBe(MAX_ENVELOPE_BYTES);
    const at = Buffer.alloc(262_116, 0x61);
    const s = seal(at, B);
    expect(Buffer.from(s.envelopeB64, 'base64').length).toBe(262_144);
    expect((await openInBrowserWay(s.envelopeB64, s.keyB64Url, B)).length).toBe(262_116);
    expect(() => seal(Buffer.alloc(262_117, 0x61), B)).toThrow(PlaintextTooLargeError);
  });
  it('keeps the key out of the envelope and the plaintext, and never reuses a key or an IV', () => {
    const a = seal(bytes, B);
    const b = seal(bytes, B);
    expect(a.keyB64Url).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.keyB64Url).not.toBe(b.keyB64Url);
    expect(a.envelopeB64).not.toBe(b.envelopeB64);
    expect(a.envelopeB64).not.toContain(a.keyB64Url);
    expect(bytes.toString()).not.toContain(a.keyB64Url);
  });
});

const payload = (over: Partial<SharePayload['item']> = {}): SharePayload => ({
  localId: 'local-1', hash: 'h', fullHash: 'f', deferredPairs: [],
  item: { source_url: 'https://github.com/o/r/pull/1', platform: 'github', title: 'Use sqlite', summary: 's', raw_text: 's', client_key: 'k', created_at: '2026-09-02T09:00:00.000Z', judgements: [{ kind: 'ratify', judged_at: '2026-09-03T00:00:00.000Z', origin: 'local_share_mcp', agent: 'codex' }], ...over },
  shown: [{ wire: { kind: 'ratify', judged_at: '2026-09-03T00:00:00.000Z', origin: 'local_share_mcp', agent: 'codex' }, hash: 'x', via: 'mcp', agentId: 'codex', counterpartTitle: 'Other' }],
  leftLocal: [{ kind: 'conflict_verdict', why: 'counterpart_not_shared', counterpartTitle: 'Local only' }],
});

describe('buildPlaintext', () => {
  it('refuses a confirm hash that is not 64 lowercase hex, and accepts one that is', () => {
    const mk = (h: string) => () => buildPlaintext({ kind: 'confirm_team_text', tenantId: T, gatewayUrl: 'g', payloads: [payload()], confirm: { remoteId: 'R9', teamTextHash: h } });
    for (const bad of ['abc', 'B'.repeat(64), 'b'.repeat(63), 'b'.repeat(65), `${'b'.repeat(63)}g`]) expect(mk(bad)).toThrow(/64-character lowercase hex/);
    expect(mk('b'.repeat(64))).not.toThrow();
  });
  it('carries the exact batch decisions (created_at becomes decided_at, once), the tenant, the gateway and labels-only display', () => {
    const plain = JSON.parse(buildPlaintext({ kind: 'share', tenantId: T, gatewayUrl: 'https://api.align.tech', payloads: [payload()] }).toString('utf8'));
    expect(plain).toMatchObject({ v: 1, kind: 'share', tenant_id: T, gateway_url: 'https://api.align.tech' });
    expect(plain.decisions[0].decided_at).toBe('2026-09-02T09:00:00.000Z');
    expect(plain.decisions[0].created_at).toBeUndefined();
    expect(plain.decisions[0].title).toBe('Use sqlite');
    expect(plain.display[0].judgements).toEqual([{ via: 'mcp', agent: 'codex', counterpart_title: 'Other' }]);
    expect(plain.display[0].left_local).toEqual([{ kind: 'conflict_verdict', why: 'counterpart_not_shared', counterpart_title: 'Local only' }]);
    expect(plain.confirm).toBeUndefined();
  });
  it('a confirm_team_text request names the team decision and the hash the judgements carry', () => {
    const plain = JSON.parse(buildPlaintext({ kind: 'confirm_team_text', tenantId: T, gatewayUrl: 'https://g', payloads: [payload()], confirm: { remoteId: 'R9', teamTextHash: 'abc' } }).toString('utf8'));
    expect(plain.kind).toBe('confirm_team_text');
    expect(plain.confirm).toEqual({ decision_id: 'R9', team_text_hash: 'b'.repeat(64) });
  });
});
