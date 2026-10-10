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

/** Issue a code; every earlier code that names any of the same decisions is invalidated. */
export function issueCode(payloads: readonly SharePayload[], meta: { agentId: string; envName: string; preview: string; to: Binding }, now = new Date()): string | null {
  const dir = dirOf();
  if (dir === null) return null;
  const ids = payloads.map((p) => p.localId);
  for (const f of fs.readdirSync(dir)) {
    const old = read(path.join(dir, f));
    if (old && old.localIds.some((i) => ids.includes(i))) fs.rmSync(path.join(dir, f), { force: true });
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const code = Array.from(randomBytes(10), (b) => alphabet[b % 32]).join('');
  const rec: PendingShare = {
    code, expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(), agentId: meta.agentId, envName: meta.envName,
    hash: combinedHash(payloads, meta.to), localIds: ids, preview: meta.preview,
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

/** Remove code files (and abandoned `.used` files) older than a day. Returns how many. Touches only its own directory. */
export function sweepPending(now = new Date()): number {
  const dir = dirOf();
  if (dir === null) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(json|used)$/.test(f)) continue;
    const file = path.join(dir, f);
    try {
      if (now.getTime() - fs.statSync(file).mtimeMs > PENDING_MAX_AGE_MS) { fs.rmSync(file, { force: true }); n += 1; }
    } catch { /* gone already */ }
  }
  return n;
}
