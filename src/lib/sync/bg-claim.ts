/**
 * L6: the per-source claim that keeps concurrent launches from each starting a child. One file per
 * source per INTERVAL BUCKET, `<source>.<floor(now / interval)>.bgclaim`, created exclusively
 * (`wx`) and never taken over: whoever creates the file for this bucket owns the interval, and
 * everyone else finds it and stops. There is no "stale, remove it and retry" step, because that is
 * what lets many launches each win once a claim is old (a remove followed by an exclusive create
 * is two steps, and every racer can pass the first).
 *
 * The previous bucket's claim is honoured while it is younger than the interval, so a bucket
 * boundary cannot double-start. After taking its own claim a launch also looks at the neighbouring
 * buckets once more and yields if one appeared meanwhile; two launches on either side of a boundary
 * may then both yield, which costs one interval of no refresh and never a second child.
 * Files older than two intervals are swept. File-system only: the launch path imports this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { kindAt, readRegularFile } from './safe-read.js';

const NAME = (source: string): RegExp => new RegExp(`^${source}\\.(\\d+)\\.bgclaim$`);

export const claimFile = (dir: string, source: string, bucket: number): string => path.join(dir, `${source}.${bucket}.bgclaim`);
const bucketOf = (now: number, intervalMs: number): number => Math.floor(now / intervalMs);

function claimAt(file: string): number | undefined {
  const raw = readRegularFile(file, 4096);
  if (raw === undefined) return undefined;
  try {
    const at = (JSON.parse(raw) as { at?: unknown }).at;
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}

/** Fresh = younger than the interval and not dated in the future. */
const fresh = (at: number | undefined, now: number, intervalMs: number): boolean => at !== undefined && at <= now && now - at < intervalMs;

/** Is a claim for this source in force (this bucket's or the previous one's)? Reads only. */
export function claimInForce(dir: string, source: string, now: number, intervalMs: number): boolean {
  const b = bucketOf(now, intervalMs);
  return [b, b - 1].some((k) => fresh(claimAt(claimFile(dir, source, k)), now, intervalMs));
}

export type ClaimResult = { ok: true } | { ok: false; why: 'held' | 'unwritable' };

export function takeClaim(dir: string, source: string, now: number, intervalMs: number): ClaimResult {
  const b = bucketOf(now, intervalMs);
  if (claimInForce(dir, source, now, intervalMs)) return { ok: false, why: 'held' };
  const mine = claimFile(dir, source, b);
  try {
    fs.writeFileSync(mine, JSON.stringify({ at: now, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    // EEXIST on a regular file: this bucket is taken (even by a claim too damaged to read), and it owns the interval.
    // EEXIST on anything else (a directory, a FIFO) is an object in the way, which no claim can replace.
    const code = (e as { code?: string }).code;
    return { ok: false, why: code === 'EEXIST' && kindAt(mine) === 'file' ? 'held' : 'unwritable' };
  }
  // A launch on the other side of a boundary may have claimed between our check and our create.
  if ([b - 1, b + 1].some((k) => { const at = claimAt(claimFile(dir, source, k)); return at !== undefined && Math.abs(now - at) < intervalMs; })) {
    try { fs.rmSync(mine, { force: true }); } catch { /* it expires on its own */ }
    return { ok: false, why: 'held' };
  }
  sweep(dir, source, b);
  return { ok: true };
}

export function releaseClaim(dir: string, source: string, now: number, intervalMs: number): void {
  try { fs.rmSync(claimFile(dir, source, bucketOf(now, intervalMs)), { force: true }); } catch { /* it expires on its own */ }
}

function sweep(dir: string, source: string, bucket: number): void {
  try {
    const re = NAME(source);
    for (const n of fs.readdirSync(dir)) {
      const m = re.exec(n);
      if (m && Number(m[1]) < bucket - 2) fs.rmSync(path.join(dir, n), { force: true });
    }
  } catch { /* a sweep that fails leaves old files, which are harmless */ }
}

/** Why a background refresh cannot record its claim for this source (a directory or other object in the way, or an unwritable state directory), or undefined. For `align sync --status`. */
export function claimProblem(dir: string, source: string, now: number, intervalMs: number): string | undefined {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return `Align cannot write to its state directory (${dir}), so it does not refresh ${source} in the background`;
  }
  const b = bucketOf(now, intervalMs);
  for (const k of [b, b - 1]) {
    if (kindAt(claimFile(dir, source, k)) === 'other') return `something that is not a file is in the way at ${claimFile(dir, source, k)}, so Align does not refresh ${source} in the background. Remove it`;
  }
  return undefined;
}
