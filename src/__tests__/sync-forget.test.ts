import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const state = vi.hoisted(() => ({ db: '', tokens: new Map<string, Record<string, string>>(), forgotten: [] as string[], confirm: true, asked: [] as string[] }));
vi.mock('@clack/prompts', () => ({ confirm: async (o: { message: string }) => { state.asked.push(o.message); return state.confirm; } }));
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
const ttyBefore = Boolean(process.stdin.isTTY && process.stdout.isTTY);
function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-forget-'));
  state.db = path.join(dir, 'graph.db');
  state.tokens = new Map([['slack', { token: 'x' }], ['github', { token: 'y' }]]);
  state.forgotten = [];
  state.confirm = true;
  state.asked = [];
  setTty(true);
  savedState = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = path.join(dir, 'state');
  const db = createLocalDb(state.db);
  for (let i = 0; i < 3; i++) db.insertDecision({ title: `thread ${i}`, summary: 's', sourceUrl: `https://slack.com/archives/C1/p170000000000000${i}`, platform: 'slack', keyed: true });
  const keep = db.insertDecision({ title: 'ratified thread', summary: 's', sourceUrl: 'https://slack.com/archives/C1/p1700000000000009', platform: 'slack', keyed: true });
  db.markRatified(keep, 'me');
  db.insertDecision({ title: 'a PR', summary: 's', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github', keyed: true });
  db.close();
  beginRun(state.db, { source: 'slack', scopeKey: 'yours', scope: 'yours' }, null, 'x');
  said = []; errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  process.exitCode = undefined;
});
afterEach(() => {
  setTty(ttyBefore);
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
    await run(['local', 'forget', 'slack', '--purge', '--yes']);
    expect(titles('slack')).toEqual(['ratified thread']);
    expect(said.join('\n')).toContain('Deleted 3 slack items nobody had vouched for, and kept 1');
    expect(state.forgotten).toEqual(['slack']);
    expect(readRows(state.db, 'slack')).toEqual([]);
    expect(titles('github')).toEqual(['a PR']);
  });

  it('works when the token was already gone: the rows are still purged, and it says nothing was saved', async () => {
    state.tokens.delete('slack');
    await run(['local', 'forget', 'slack', '--purge', '--yes']);
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

describe('forget --purge asks first', () => {
  it('at a terminal it shows the count, asks (default No), and with No changes nothing, token included', async () => {
    state.confirm = false;
    await run(['local', 'forget', 'slack', '--purge']);
    expect(state.asked[0]).toContain('Delete 3 slack items nobody has vouched for (keeping 1)');
    expect(titles('slack')).toHaveLength(4);
    expect(state.forgotten).toEqual([]);
    expect(said.join('\n')).toContain('Cancelled. Nothing was changed.');
  });

  it('at a terminal, answering Yes goes ahead', async () => {
    await run(['local', 'forget', 'slack', '--purge']);
    expect(titles('slack')).toEqual(['ratified thread']);
    expect(state.forgotten).toEqual(['slack']);
  });

  it('with no terminal and no --yes it refuses (exit 2), names --yes, and changes nothing', async () => {
    setTty(false);
    await run(['local', 'forget', 'slack', '--purge']);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toContain('--yes');
    expect(state.asked).toEqual([]);
    expect(titles('slack')).toHaveLength(4);
    expect(state.forgotten).toEqual([]);
  });

  it('with nothing to delete there is nothing to confirm', async () => {
    state.tokens.set('jira', { token: 'z' });
    setTty(false);
    await run(['local', 'forget', 'jira', '--purge']);
    expect(process.exitCode).toBeUndefined();
    expect(state.forgotten).toEqual(['jira']);
  });

  it.each(['cli', 'git', 'docs', 'slakc'])('%s is not a connector source: exit 2, nothing deleted, no token forgotten', async (name) => {
    state.tokens.set(name, { token: 'z' });
    await run(['local', 'forget', name, '--purge', '--yes']);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toContain('--purge needs the name of a connected source');
    expect(titles('slack')).toHaveLength(4);
    expect(state.forgotten).toEqual([]);
  });

  it('the graph is changed before the token, in one transaction: a failure leaves the token saved and every row in place', async () => {
    const d = new DatabaseSync(state.db); d.exec('DROP TABLE decisions_purged_backup'); d.close();
    await run(['local', 'forget', 'slack', '--purge', '--yes']);
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('The saved token was not removed.');
    expect(state.tokens.has('slack')).toBe(true);
    expect(state.forgotten).toEqual([]);
    expect(titles('slack')).toHaveLength(4);
    expect(readRows(state.db, 'slack')).toHaveLength(1);
  });
});

describe('guards', () => {
  it('--purge with no connector is refused, exit 2, nothing deleted and no token forgotten', async () => {
    await run(['local', 'forget', '--purge']);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toContain('--purge needs the name of a connected source');
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
