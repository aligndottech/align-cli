// P3: an unknown ALIGN_DETECTOR stops the CLI at startup, naming the allowed values, before any
// command runs. Real process; HOME and XDG dirs point at a scratch dir so the startup directory
// migration cannot touch a real config.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let scratch: string;
beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'align-detector-startup-')); });
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

function run(detector: string | undefined) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, XDG_CONFIG_HOME: path.join(scratch, '.config'), XDG_DATA_HOME: path.join(scratch, '.data'), ALIGN_NO_SYNC: '1' };
  delete env['ALIGN_DETECTOR'];
  if (detector !== undefined) env['ALIGN_DETECTOR'] = detector;
  return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'index.ts'), '--version'], { env, encoding: 'utf8', timeout: 60_000 });
}

describe('ALIGN_DETECTOR at startup', () => {
  it('v2 exits 1 naming the allowed values', () => {
    const r = run('v2');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ALIGN_DETECTOR="v2".*v0, v1/);
  });

  it('v1 and unset start normally', () => {
    expect(run('v1').status).toBe(0);
    expect(run(undefined).status).toBe(0);
  });
}, 120_000);
