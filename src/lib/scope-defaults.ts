/**
 * L4: what to preselect when a person picks a Jira project or a Linear team: the ticket prefixes their own decisions already
 * cite (`decision_refs`, ALI-792). A suggestion only - the picker shows it, and a non-interactive run uses it as the plan says
 * (Decision 7) - so it is cheap, local and never an error: no graph, no refs table or no refs all give an empty list.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MAX_SUGGESTED = 10;
const TICKET = /(?:^|\/)([A-Z][A-Z0-9_]+)-\d+$/;
const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Project or team prefixes cited by tracker-shaped refs, most-cited decisions first, then by name; at most ten. */
export function citedProjectKeys(dbPath: string): string[] {
  // A reader must never create the graph it was asked to look at: opening a missing path makes an empty file.
  if (!fs.existsSync(dbPath)) return [];
  let rows: Array<{ decision_id: string; ref: string }>;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    rows = db.prepare(`SELECT decision_id, ref FROM decision_refs WHERE platform IN ('jira', 'tracker')`).all() as typeof rows;
  } catch {
    return []; // an older file with no refs table
  } finally {
    db.close();
  }
  const citedBy = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = TICKET.exec(r.ref)?.[1];
    if (key === undefined) continue;
    const set = citedBy.get(key) ?? new Set<string>();
    set.add(r.decision_id);
    citedBy.set(key, set);
  }
  return [...citedBy.entries()]
    .sort(([ak, as], [bk, bs]) => bs.size - as.size || codeUnit(ak, bk))
    .slice(0, MAX_SUGGESTED)
    .map(([key]) => key);
}
