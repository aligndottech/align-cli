/**
 * L5 test harness: a real v7 graph file, a real lock directory, a scripted fetch. Nothing here
 * touches the network, the real config store or the user's graph.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FetcherItem } from '@aligndottech/connector-core';
import { createLocalGatewayClient } from '../../lib/local-gateway-client.js';
import type { CaptureFetchReport } from '../../lib/fetchers/capture.js';
import { acquireLock } from '../../lib/sync/lock.js';
import type { SyncEnv } from '../../lib/sync/run-source.js';
import type { SourceWindow } from '../../lib/sync/sources.js';

export interface Harness {
  dir: string;
  dbPath: string;
  lockDir: string;
  env: SyncEnv;
  fetchCalls: Array<{ source: string; win: SourceWindow }>;
  /** Script the next fetch(es): each call takes the next entry; the last one repeats. */
  script(...results: Array<{ items: FetcherItem[]; report?: Partial<CaptureFetchReport> } | Error>): void;
  close(): void;
  cleanup(): void;
}

export const NOW = new Date('2026-10-10T12:00:00.000Z');

export function harness(over: Partial<SyncEnv> = {}, opts: { alive?: (pid: number) => boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-run-'));
  const dbPath = path.join(dir, 'graph.db');
  const lockDir = path.join(dir, 'locks');
  fs.mkdirSync(lockDir);
  const client = createLocalGatewayClient(dbPath);
  const fetchCalls: Harness['fetchCalls'] = [];
  let scripted: Array<{ items: FetcherItem[]; report?: Partial<CaptureFetchReport> } | Error> = [];
  let call = 0;
  const env: SyncEnv = {
    dbPath,
    now: () => NOW,
    tokens: () => ({ token: 'tok' }),
    scopeOf: async () => ({ scopeKey: 'yours', scope: 'yours' }),
    fetch: async (source, _t, win) => {
      fetchCalls.push({ source, win });
      const r = scripted[Math.min(call, scripted.length - 1)];
      call += 1;
      if (r === undefined) throw new Error('the harness has no scripted fetch');
      if (r instanceof Error) throw r;
      return { items: r.items, report: { scanned: r.items.length, skips: [], complete: true, ...r.report } };
    },
    client,
    lock: (name) => acquireLock(name, { dir: lockDir, alive: opts.alive ?? (() => true) }),
    backfillRunning: () => false,
    drain: async () => ({ enriched: 0, remaining: 0, skips: [] }),
    ...over,
  };
  return {
    dir, dbPath, lockDir, env, fetchCalls,
    script: (...results) => { scripted = results; call = 0; },
    close: () => client.close(),
    cleanup: () => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export const pr = (n: number, updated: string, extra: Partial<FetcherItem> = {}): FetcherItem => ({
  source_url: `https://github.com/o/r/pull/${n}`, platform: 'github', title: `PR ${n}`, raw_text: `PR ${n}\n\nbody ${n}\n\nStatus: open\nRepo: o/r`,
  created_at: updated, updated_at: updated, ...extra,
});
export const slackThread = (channel: string, rootTs: string, text: string, updated: string, extra: Partial<FetcherItem> = {}): FetcherItem => ({
  source_url: `https://slack.com/archives/${channel}/p${rootTs.replace('.', '')}`, platform: 'slack', title: text.split('\n')[0]!.slice(0, 80),
  raw_text: `[#eng] Thread:\n${text}`, created_at: new Date(Number(rootTs) * 1000).toISOString(), updated_at: updated, ...extra,
});
