/**
 * L9: confirmation codes for a share an agent started (Decision 17, stage 1).
 *
 * `align_share` builds the preview, stores the exact payloads here under a short code, and returns
 * the code. It never sends. A person completes it with `align share --confirm <code>` at a terminal.
 * A code is single use, expires after 10 minutes, is bound to the payload hash (a changed local row
 * is refused), and a new code for the same decisions invalidates the old one.
 *
 * Files live in `<state home>/align-cli/pending-shares/`, mode 0600 (they hold decision text), in a
 * directory that is ours and private (alignStateDir's lstat checks refuse a planted link).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alignStateDir } from '../backfill-state.js';
import type { SharePayload } from './payload.js';

export const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_RE = /^[a-z2-7]{10}$/;

export interface PendingShare {
  code: string;
  expiresAt: string;
  agentId: string;
  envName: string;
  /** Hash over every payload hash, in order. */
  hash: string;
  localIds: string[];
  /** The exact text previewed, so the confirmation re-renders what the agent's person was shown. */
  preview: string;
}

function dirOf(): string | null {
  const base = alignStateDir();
  if (base === null) return null;
  const dir = path.join(base, 'pending-shares');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
  } catch { return null; }
}

/** Where a share goes: the workspace AND the gateway, so a code cannot be used after either changed. */
export interface Binding { tenantId: string; gatewayUrl: string }

export function combinedHash(payloads: readonly SharePayload[], to: Binding): string {
  return [`to:${to.tenantId}@${to.gatewayUrl}`, ...payloads.map((p) => p.hash)].join('|');
}

function read(file: string): PendingShare | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as PendingShare; } catch { return null; }
}

/**
 * Issue a code. A live code for the SAME payload and destination is returned as it is (re-asking must not
 * invalidate the one the person may already be typing); any other earlier code that names one of the same
 * decisions is invalidated.
 */
export function issueCode(payloads: readonly SharePayload[], meta: { agentId: string; envName: string; preview: string; to: Binding }, now = new Date()): string | null {
  const dir = dirOf();
  if (dir === null) return null;
  const ids = payloads.map((p) => p.localId);
  const hash = combinedHash(payloads, meta.to);
  for (const f of fs.readdirSync(dir)) {
    const old = read(path.join(dir, f));
    if (!old || !old.localIds.some((i) => ids.includes(i))) continue;
    if (old.hash === hash && old.envName === meta.envName && Date.parse(old.expiresAt) > now.getTime()) return old.code;
    fs.rmSync(path.join(dir, f), { force: true });
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const code = Array.from(randomBytes(10), (b) => alphabet[b % 32]).join('');
  const rec: PendingShare = {
    code, expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(), agentId: meta.agentId, envName: meta.envName,
    hash, localIds: ids, preview: meta.preview,
  };
  fs.writeFileSync(path.join(dir, `${code}.json`), JSON.stringify(rec), { mode: 0o600 });
  return code;
}

export type CodeCheck = { ok: true; pending: PendingShare } | { ok: false; reason: 'malformed' | 'unknown' | 'expired' };

/** Read a code without using it. An expired file is removed. */
export function lookupCode(code: string, now = new Date()): CodeCheck {
  if (!CODE_RE.test(code)) return { ok: false, reason: 'malformed' }; // never builds a path from free text
  const dir = dirOf();
  if (dir === null) return { ok: false, reason: 'unknown' };
  const file = path.join(dir, `${code}.json`);
  const rec = read(file);
  if (!rec) return { ok: false, reason: 'unknown' };
  if (Date.parse(rec.expiresAt) <= now.getTime()) { fs.rmSync(file, { force: true }); return { ok: false, reason: 'expired' }; }
  return { ok: true, pending: rec };
}

/**
 * Single use, and atomic: the file is RENAMED to a name only this call owns, and only the caller whose
 * rename succeeded wins. Two racers cannot both pass an exists-then-delete check.
 */
export function consumeCode(code: string): boolean {
  if (!CODE_RE.test(code)) return false;
  const dir = dirOf();
  if (dir === null) return false;
  const file = path.join(dir, `${code}.json`);
  const mine = path.join(dir, `${code}.${process.pid}.${randomBytes(4).toString('hex')}.used`);
  try { fs.renameSync(file, mine); } catch { return false; }
  fs.rmSync(mine, { force: true });
  return true;
}

export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Remove code files (and abandoned `.used` files) older than a day. Returns how many. Touches only its own directories. */
export function sweepPending(now = new Date()): number {
  let n = 0;
  for (const dir of [dirOf(), requestsDir()]) {
    if (dir === null) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(json|used|claimed)$/.test(f)) continue;
      const file = path.join(dir, f);
      try {
        if (now.getTime() - fs.statSync(file).mtimeMs > PENDING_MAX_AGE_MS) { fs.rmSync(file, { force: true }); n += 1; }
      } catch { /* gone already */ }
    }
  }
  return n;
}

/**
 * ALI-1540: a share staged for BROWSER approval, kept so a later call (the MCP `align_share_status`) can finish it
 * and so asking again returns the same live link instead of burning one of the gateway's five live requests.
 *
 * It holds what is secret: the key (it makes the link) and the exact plaintext bytes (decision text). So the file is
 * 0600 in the same private directory as the codes, and it is deleted the moment the request reaches an end. The
 * server never has the key; this file is the only other place it rests, by design, and an agent that staged the
 * request already knew the text it sealed.
 */
export interface PendingRequest {
  requestId: string;
  kind: 'share' | 'confirm_team_text';
  envName: string;
  tenantId: string;
  gatewayUrl: string;
  /** base64url of the 32-byte key. */
  keyB64Url: string;
  /** The exact plaintext bytes, base64: what `complete` sends. */
  bytesB64: string;
  sha256: string;
  /** combinedHash of the payloads this was built from: a changed local row is refused at completion. */
  hash: string;
  localIds: string[];
  agentId: string;
  userCode: string;
  expiresAt: string;
}

const REQUEST_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requestsDir(): string | null {
  const base = alignStateDir();
  if (base === null) return null;
  const dir = path.join(base, 'pending-requests');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
  } catch { return null; }
}

/** Store a request. False when there is no safe place for it (the caller must then not hand out a link it cannot finish). */
export function saveRequest(rec: PendingRequest): boolean {
  const dir = requestsDir();
  if (dir === null || !REQUEST_FILE_RE.test(rec.requestId)) return false;
  try { fs.writeFileSync(path.join(dir, `${rec.requestId}.json`), JSON.stringify(rec), { mode: 0o600 }); return true; } catch { return false; }
}

export function loadRequest(id: string): PendingRequest | null {
  const dir = requestsDir();
  if (dir === null || !REQUEST_FILE_RE.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as PendingRequest; } catch { return null; }
}

export function deleteRequest(id: string): void {
  const dir = requestsDir();
  if (dir === null || !REQUEST_FILE_RE.test(id)) return;
  fs.rmSync(path.join(dir, `${id}.json`), { force: true });
}

/** A live request for the SAME payload and destination, if this machine staged one that has not run out. */
export function findLiveRequest(hash: string, envName: string, now = new Date()): PendingRequest | null {
  const dir = requestsDir();
  if (dir === null) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let rec: PendingRequest | null = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PendingRequest; } catch { continue; }
    if (rec.kind === 'share' && rec.hash === hash && rec.envName === envName && Date.parse(rec.expiresAt) > now.getTime()) return rec;
  }
  return null;
}

export interface Claim { request: PendingRequest; finish: () => void; release: () => void }

/**
 * Take a request to finish it. Atomic like consumeCode: the file is RENAMED to a name only this call owns, and only
 * the caller whose rename worked gets it, so two status calls cannot both complete the same share. `finish` deletes
 * it for good; `release` puts it back (the completion call never reached a verdict, so a retry is still meaningful).
 */
export function claimRequest(id: string): Claim | null {
  const dir = requestsDir();
  if (dir === null || !REQUEST_FILE_RE.test(id)) return null;
  const file = path.join(dir, `${id}.json`);
  const mine = path.join(dir, `${id}.${process.pid}.${randomBytes(4).toString('hex')}.claimed`);
  try { fs.renameSync(file, mine); } catch { return null; }
  let request: PendingRequest;
  try { request = JSON.parse(fs.readFileSync(mine, 'utf8')) as PendingRequest; } catch { fs.rmSync(mine, { force: true }); return null; }
  return {
    request,
    finish: () => { fs.rmSync(mine, { force: true }); },
    release: () => { try { fs.renameSync(mine, file); } catch { /* swept or gone */ } },
  };
}
