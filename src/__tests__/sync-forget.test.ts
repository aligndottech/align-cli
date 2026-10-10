import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const state = vi.hoisted(() => ({ db: '', tokens: new Map<string, Record<string, string>>(), forgotten: [] as string[] }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getEnvironment: () => ({ mode: 'local-embedded', localDbPath: state.db }),
    getConnectorFields: (_e: string, id: string) => state.tokens.get(id) ?? null,
    forgetConnector: (_e: string, id: string) => { state.forgotten.push(id); state.tokens.delete(id); },
    forgetAllConnectors: () => { state.forgotten.push('*'); state.tokens.clear(); },
  }),
}));

import { registerLocalCommand } from '../commands/local.js';
import { createLocalDb } from '../lib/local-db.js';
import { readSummary } from '../lib/sync/summary.js';
import { beginRun, readRows } from '../lib/sync/sync-state.js';

/**
 * L5 Test List (`align local forget <src> [--purge]`):
 * - Given `forget slack --purge`: Slack rows with no ratification, no audit act and no local judgement are deleted, and the line prints the deleted and kept counts.
 * - Given no --purge: only the token and the source_sync row go, and the line says how many rows stay.
 * - --purge with no connector is refused (exit 2) and deletes nothing. Forgetting drops the source from the launch summary.
 */
vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let said: string[];
let errs: string[];
let savedState: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-forget-'));
  state.db = path.join(dir, 'graph.db');
  state.tokens = new Map([['slack', { token: 'x' }], ['github', { token: 'y' }]]);
  state.forgotten = [];
  savedState = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = path.join(dir, 'state');
  const db = createLocalDb(state.db);
  for (let i = 0; i < 3; i++) db.insertDecision({ title: `thread ${i}`, summary: 's', sourceUrl: `https://slack.com/archives/C1/p170000000000000${i}`, platform: 'slack' });
  const keep = db.insertDecision({ title: 'ratified thread', summary: 's', sourceUrl: 'https://slack.com/archives/C1/p1700000000000009', platform: 'slack' });
  db.markRatified(keep, 'me');
  db.insertDecision({ title: 'a PR', summary: 's', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github' });
  db.close();
  beginRun(state.db, { source: 'slack', scopeKey: 'yours', scope: 'yours' }, null, 'x');
  said = []; errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (savedState === undefined) delete process.env['XDG_STATE_HOME']; else process.env['XDG_STATE_HOME'] = savedState;
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[]) => { const p = new Command(); p.exitOverride(); registerLocalCommand(p); return p.parseAsync(['node', 'align', ...args]); };
const titles = (platform: string) => {
  const d = new DatabaseSync(state.db);
  try { return (d.prepare('SELECT title FROM decisions WHERE platform = ? ORDER BY title').all(platform) as Array<{ title: string }>).map((r) => r.title); } finally { d.close(); }
};

describe('forget --purge', () => {
  it('deletes the unvouched rows, keeps the ratified one, and prints both counts', async () => {
    await run(['local', 'forget', 'slack', '--purge']);
    expect(titles('slack')).toEqual(['ratified thread']);
    expect(said.join('\n')).toContain('Deleted 3 slack items nobody had vouched for, and kept 1');
    expect(state.forgotten).toEqual(['slack']);
    expect(readRows(state.db, 'slack')).toEqual([]);
    expect(titles('github')).toEqual(['a PR']);
  });

  it('works when the token was already gone: the rows are still purged, and it says nothing was saved', async () => {
    state.tokens.delete('slack');
    await run(['local', 'forget', 'slack', '--purge']);
    expect(said.join('\n')).toContain('Nothing saved for slack.');
    expect(titles('slack')).toEqual(['ratified thread']);
  });
});

describe('forget without --purge', () => {
  it('drops the token and the sync rows, deletes no item, and says how many stay and how to purge', async () => {
    await run(['local', 'forget', 'slack']);
    expect(titles('slack')).toHaveLength(4);
    expect(readRows(state.db, 'slack')).toEqual([]);
    expect(said.join('\n')).toContain('4 slack items stay in your graph.');
    expect(said.join('\n')).toContain('align local forget slack --purge');
  });

  it('the launch summary no longer lists the forgotten source', async () => {
    await run(['local', 'forget', 'slack']);
    expect(readSummary(path.join(dir, 'state', 'align-cli'))?.sources.map((s) => s.id)).toEqual(['github']);
  });

  it('a source with no items says nothing about staying', async () => {
    state.tokens.set('jira', { token: 'z' });
    await run(['local', 'forget', 'jira']);
    expect(said.join('\n')).not.toContain('stay in your graph');
  });
});

describe('guards', () => {
  it('--purge with no connector is refused, exit 2, nothing deleted and no token forgotten', async () => {
    await run(['local', 'forget', '--purge']);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toContain('--purge needs a connector name');
    expect(titles('slack')).toHaveLength(4);
    expect(state.forgotten).toEqual([]);
  });

  it('forgetting everything clears the sync rows of every source but deletes no item', async () => {
    await run(['local', 'forget']);
    expect(readRows(state.db)).toEqual([]);
    expect(titles('slack')).toHaveLength(4);
    expect(state.forgotten).toEqual(['*']);
  });
});
