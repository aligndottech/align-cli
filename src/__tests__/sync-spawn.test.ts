import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKFILL_STATUS_ENV, startBackfillChild } from '../lib/backfill-state.js';
import { startSyncChild, syncChildArgv } from '../lib/sync/spawn-background.js';

describe('startSyncChild', () => {
  it('builds `sync --background --delay N <sources>` (two examples)', () => {
    expect(syncChildArgv(['github'])).toEqual(['sync', '--background', '--delay', '0', 'github']);
    expect(syncChildArgv(['github', 'jira'], { delaySeconds: 20 })).toEqual(['sync', '--background', '--delay', '20', 'github', 'jira']);
  });

  it('hands the argv to the detached starter with NO status file, and returns what it confirmed', async () => {
    const start = vi.fn(async () => ({ ok: true, pid: 7 }));
    const r = await startSyncChild(['slack'], { start });
    expect(r).toEqual({ ok: true, pid: 7 });
    const [name, argv, file, cmd] = start.mock.calls[0] as unknown as [string, string[], unknown, { command: string; args: string[] }];
    expect(name).toBe('sync');
    expect(argv).toEqual(['sync', '--background', '--delay', '0', 'slack']);
    expect(file).toBeUndefined();
    expect(cmd.args).toContain('sync');
  });

  it('a start that did not confirm is reported as not started', async () => {
    expect(await startSyncChild(['slack'], { start: async () => ({ ok: false }) })).toEqual({ ok: false });
  });
});

describe('a real detached child with no status file', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-spawn-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('starts, writes no status file, and does not inherit this process\'s backfill status path', async () => {
    const out = path.join(dir, 'seen.txt');
    const saved = process.env[BACKFILL_STATUS_ENV];
    process.env[BACKFILL_STATUS_ENV] = path.join(dir, 'leak.json');
    try {
      const r = await startBackfillChild('sync', ['x'], undefined, {
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, String(process.env.${BACKFILL_STATUS_ENV}))`],
      });
      expect(r.ok).toBe(true);
      for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
      expect(fs.readFileSync(out, 'utf8')).toBe('undefined');
      expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env[BACKFILL_STATUS_ENV]; else process.env[BACKFILL_STATUS_ENV] = saved;
    }
  });
});
