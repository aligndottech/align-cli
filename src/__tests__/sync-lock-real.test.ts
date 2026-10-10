import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockFile } from '../lib/sync/lock.js';

/**
 * L5: the lock between REAL processes (the unit tests inject liveness and one clock). Four separate
 * node processes wait for the same instant and then all try to take one lock: exactly one wins, the
 * others are told who holds it. Then the winner exits WITHOUT releasing (a kill), and a fifth process
 * takes over because the pid is dead. Runs the same on Windows: no flock, no signals, only exclusive create.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-lockreal-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function script(): string {
  const file = path.join(dir, 'try-lock.mts');
  fs.writeFileSync(file, `
    import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'lib', 'sync', 'lock.ts')).href)};
    const [dirArg, startAt, hold] = process.argv.slice(2);
    while (Date.now() < Number(startAt)) { /* every contender leaves the gate together */ }
    const l = acquireLock('sync-race', { dir: dirArg });
    console.log(l.ok ? 'WON ' + process.pid : 'HELD ' + (l.holder ? l.holder.pid : 'unknown'));
    if (l.ok && hold === 'die') process.exit(0); // exits WITHOUT releasing
    if (l.ok) setTimeout(() => { l.release(); process.exit(0); }, Number(hold));
    else process.exit(0);
  `);
  return file;
}

function run(file: string, startAt: number, hold: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), file, dir, String(startAt), hold], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

describe('the sync lock between real processes', () => {
  it('four contenders: exactly one wins and the rest name the winner; a killed winner is taken over', async () => {
    const file = script();
    const startAt = Date.now() + 6_000; // tsx start-up varies by seconds on a loaded machine; the gate absorbs it
    const results = await Promise.all([0, 1, 2, 3].map(() => run(file, startAt, '2500')));
    const won = results.filter((r) => r.startsWith('WON'));
    const held = results.filter((r) => r.startsWith('HELD'));
    expect(won).toHaveLength(1);
    expect(held).toHaveLength(3);
    const winnerPid = won[0]!.split(' ')[1];
    for (const h of held) expect(h).toBe(`HELD ${winnerPid}`);

    // A process that dies holding the lock (no release) leaves a file whose pid is gone.
    const dead = await run(file, 0, 'die');
    expect(dead).toMatch(/^WON /);
    expect(fs.existsSync(lockFile(dir, 'sync-race'))).toBe(true);
    expect(await run(file, 0, '10')).toMatch(/^WON /);
  }, 120_000);
});
