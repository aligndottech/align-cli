import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCodePluginBody } from '../lib/agent-rules.js';
import { findOnPath } from '../lib/launch/detect.js';
import { writeIfChanged } from '../lib/launch/launch-files.js';
import { launchIfChosen } from '../lib/launch/launch.js';
import { readOpenCodeState } from '../lib/launch/opencode-state.js';
import { readProjectState } from '../lib/launch/project-state.js';
import { runAgent } from '../lib/launch/run-agent.js';

/*
 * The real pipeline (state reader, builder, launch-file writer, spawn) against a FAKE opencode
 * on PATH that records its argv and the OpenCode env it was given. The real opencode is never run.
 */
let root: string, bin: string, cache: string, cwd: string, home: string, record: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-oc-e2e-')));
  bin = path.join(root, 'bin'); cache = path.join(root, 'cache'); cwd = path.join(root, 'repo'); home = path.join(root, 'home');
  record = path.join(root, 'record.json');
  mkdirSync(bin); mkdirSync(path.join(cwd, '.git'), { recursive: true }); mkdirSync(home);
  const script = path.join(bin, 'opencode');
  writeFileSync(script, `#!/bin/sh
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), content: process.env.OPENCODE_CONFIG_CONTENT ?? null, dir: process.env.OPENCODE_CONFIG_DIR ?? null, wrapped: process.env.ALIGN_WRAPPED ?? null}))' "${record}" "$@"
exit 7
`);
  chmodSync(script, 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env['PATH']}`);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const run = (argv: string[], env: Record<string, string | undefined> = {}) =>
  launchIfChosen({
    env: { ...process.env, ...env }, argv, cwd, home, platform: process.platform, isTTY: true,
    config: { getAgent: () => 'opencode', setAgent: () => {} },
    findOnPath,
    readProjectState: (c, h) => readProjectState(c, h, { localIsDefault: true }),
    readOpenCodeState: (c, h) => readOpenCodeState(c, h, { localIsDefault: true }),
    cacheDir: () => cache, writeIfChanged, runAgent: (spec) => runAgent(spec),
    record: () => {}, pick: async () => null, err: () => {}, now: () => 0,
  });
const recorded = () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; content: string | null; dir: string | null; wrapped: string | null };

describe('launch opencode against a fake binary', () => {
  it('runs it with the user\'s args, the injected env, the plugin on disk, and returns its exit code', async () => {
    expect(await run(['node', 'align', '--', 'run', 'hello'])).toEqual({ handled: true, code: 7 });
    const r = recorded();
    expect(r.argv).toEqual(['run', 'hello']);
    expect(r.wrapped).toBe('1');
    expect(JSON.parse(r.content!).mcp['align-local'].command).toEqual(['align', 'mcp', '--env', 'local']);
    expect(r.dir).toBe(path.join(cache, 'opencode-config'));
    expect(readFileSync(path.join(r.dir!, 'plugins', 'align.js'), 'utf8')).toBe(openCodePluginBody('local'));
  });

  it('writes nothing into the project or the home dir', async () => {
    await run(['node', 'align', '--', 'x']);
    expect(existsSync(path.join(cwd, 'opencode.json'))).toBe(false);
    expect(existsSync(path.join(cwd, '.opencode'))).toBe(false);
    expect(existsSync(path.join(home, '.config'))).toBe(false);
  });

  it('a project that already has the local plugin gets no OPENCODE_CONFIG_DIR', async () => {
    mkdirSync(path.join(cwd, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(path.join(cwd, '.opencode', 'plugins', 'align.js'), openCodePluginBody('local'));
    await run(['node', 'align', '--', 'x']);
    expect(recorded().dir).toBeNull();
  });

  it('merges the user\'s own OPENCODE_CONFIG_CONTENT end to end', async () => {
    await run(['node', 'align', '--', 'x'], { OPENCODE_CONFIG_CONTENT: '{"model":"a/b"}' });
    const cfg = JSON.parse(recorded().content!);
    expect(cfg.model).toBe('a/b');
    expect(cfg.mcp['align-local']).toBeDefined();
  });
});
