import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlannedTask } from './ledger.js';
import type { TrackerId } from './trackers.js';

/**
 * The plan the MCP tool showed, kept until the same person says yes. The first call writes it and creates nothing; the
 * second call names it by token and creates exactly these tasks, once. A token is 24 hex characters from the system's
 * random source, so an agent that never saw one cannot make one, and it is checked against that shape before any path is
 * built from it. The file holds titles and bodies the person was shown, and no credential.
 */
export interface StoredPlan {
  decision: { id: string; title: string; summary: string; sourceUrl: string | null; actions: string[] };
  tracker: TrackerId; target: string; key: string; tasks: PlannedTask[]; expiresAt: string;
}

export const PLAN_TTL_MS = 30 * 60_000;
const TOKEN = /^[0-9a-f]{24}$/;
export const isPlanToken = (s: string): boolean => TOKEN.test(s);

const fileFor = (dir: string, token: string): string => path.join(dir, `${token}.json`);

function sweep(dir: string, now: number): void {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const at = Date.parse((JSON.parse(fs.readFileSync(file, 'utf8')) as { expiresAt?: string }).expiresAt ?? '');
      if (!Number.isFinite(at) || at < now) fs.rmSync(file, { force: true });
    } catch { fs.rmSync(file, { force: true }); }
  }
}

export function savePlan(dir: string, plan: Omit<StoredPlan, 'expiresAt'>, now = Date.now()): { token: string; expiresAt: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweep(dir, now);
  const token = randomBytes(12).toString('hex');
  const expiresAt = new Date(now + PLAN_TTL_MS).toISOString();
  fs.writeFileSync(fileFor(dir, token), JSON.stringify({ ...plan, expiresAt }), { mode: 0o600 });
  return { token, expiresAt };
}

/** Read the plan and delete it in one step, so a token is good for one confirmation. Null: never issued, used, or expired. */
export function takePlan(dir: string, token: string, now = Date.now()): StoredPlan | null {
  if (!isPlanToken(token)) return null;
  const file = fileFor(dir, token);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  // The delete is the claim: of two confirmations racing for one file, only the one whose delete works proceeds.
  try { fs.unlinkSync(file); } catch { return null; }
  try {
    const plan = JSON.parse(raw) as StoredPlan;
    return Date.parse(plan.expiresAt) >= now ? plan : null;
  } catch { return null; }
}
