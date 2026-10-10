// L2: local_judgements records a person's verdict on a decision (a false alarm, a real
// conflict, a supersession, "not a decision", a note), with who judged, when, and whether it
// came from the CLI or an agent over MCP. Ratification is NOT here: it stays in
// decisions.ratified_by/ratified_at (Decision 14), so one fact keeps one writer.
//
// LM adds the writer; these tests pin the table's own rules, which hold for any writer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';

// Real SQLite files; the Windows runner opens one in about a second (see decided-at.test.ts).
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l2-judge-'));
  const dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
  db = new DatabaseSync(dbPath);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function judge(row: Partial<Record<string, string | null>>): void {
  const full: Record<string, string | null> = {
    id: `j${n++}`, decision_id: 'd1', counterpart_id: 'd2', context_key: null, kind: 'conflict_verdict',
    value: 'false', note: null, judge_id: 'inst-1', judge_label: 'tom@align.tech', via: 'cli', agent_id: null,
    judged_at: '2026-10-10T09:00:00.000Z', ...row,
  };
  const cols = Object.keys(full);
  db.prepare(`INSERT INTO local_judgements (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => full[c]));
}

describe('local_judgements', () => {
  it('stores a CLI verdict with the judge and the time', () => {
    judge({});
    expect(db.prepare(`SELECT judge_id, judge_label, via, agent_id, judged_at FROM local_judgements`).all()).toEqual([
      { judge_id: 'inst-1', judge_label: 'tom@align.tech', via: 'cli', agent_id: null, judged_at: '2026-10-10T09:00:00.000Z' },
    ]);
  });

  it('an MCP verdict must name the agent, and a CLI verdict must not', () => {
    expect(() => judge({ via: 'mcp', agent_id: null })).toThrow(/CHECK/);
    expect(() => judge({ via: 'cli', agent_id: 'claude-code' })).toThrow(/CHECK/);
    judge({ via: 'mcp', agent_id: 'claude-code' });
  });

  it('rejects an unknown via, kind or value', () => {
    expect(() => judge({ via: 'web' })).toThrow(/CHECK/);
    expect(() => judge({ kind: 'ratify' })).toThrow(/CHECK/);
    expect(() => judge({ value: 'maybe' })).toThrow(/CHECK/);
  });

  it('a check verdict needs the checked diff context, and only a check verdict carries one', () => {
    expect(() => judge({ kind: 'check_verdict', counterpart_id: null, context_key: null })).toThrow(/CHECK/);
    expect(() => judge({ kind: 'conflict_verdict', context_key: 'abc' })).toThrow(/CHECK/);
    judge({ kind: 'check_verdict', counterpart_id: null, context_key: 'sha256-of-paths' });
  });

  it('one verdict per person per pair; a different person may judge the same pair', () => {
    judge({});
    expect(() => judge({ value: 'real' })).toThrow(/UNIQUE/);
    judge({ judge_id: 'inst-2' });
  });

  it('notes are not one-per-person', () => {
    judge({ kind: 'note', counterpart_id: null, value: null, note: 'first' });
    judge({ kind: 'note', counterpart_id: null, value: null, note: 'second' });
    expect((db.prepare(`SELECT count(*) AS n FROM local_judgements WHERE kind = 'note'`).get() as { n: number }).n).toBe(2);
  });

  it('judged_at, judge_id, kind and via are required', () => {
    expect(() => judge({ judged_at: null })).toThrow(/NOT NULL/);
    expect(() => judge({ judge_id: null })).toThrow(/NOT NULL/);
    expect(() => judge({ via: null })).toThrow(/NOT NULL/);
  });
});
