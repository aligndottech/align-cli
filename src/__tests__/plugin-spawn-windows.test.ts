import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restorePlatform, setPlatform } from './helpers/platform.js';
import { writeOpenCodePlugin, writePiExtension } from '../lib/agent-rules.js';

/**
 * ALI-1184. The pi extension and the opencode plugin are GENERATED CODE that runs on the
 * user's machine, and both spawned a bare `align`. On Windows npm installs `align.cmd`, and
 * a process spawn resolves a `.cmd` only through a shell, so the spawn fails.
 *
 * WHY THIS IS WORSE THAN THE CONFIG CASE ALI-1135 FIXED, despite the lower priority: it
 * FAILS OPEN. The config case was loud - VS Code showed the user `spawn align ENOENT` and
 * nothing worked, so it got reported within a day. These call sites run an ADVISORY check
 * and are fail-open by design, so a failed spawn returns null and the edit proceeds
 * untouched. A Windows user gets a plugin that installs, never errors, and never checks
 * anything. The loud bug is fixed; the quiet one was still live.
 *
 * THE FIX BRANCHES AT RUNTIME, NOT AT GENERATION TIME, and that is the substance rather than
 * a detail. ALI-1135 chose the spawn form when WRITING a config, because a JSON config cannot
 * branch. This is JavaScript, so it can - and it must, because a generated plugin is a file
 * that can be committed, shared, or synced to a machine with a different OS than the one that
 * generated it. Baking the generating platform into it would work on the author's laptop and
 * fail for everyone else, which is the same defect one layer along.
 *
 * So the strongest assertion in this file is that the output is IDENTICAL on every platform.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'align-plugin-spawn-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  restorePlatform();
});

const PLUGINS = [
  { name: 'pi extension', write: writePiExtension, rel: join('.pi', 'extensions', 'align.ts') },
  { name: 'opencode plugin', write: writeOpenCodePlugin, rel: join('.opencode', 'plugins', 'align.js') },
];

function generatedOn(platform: 'win32' | 'linux' | 'darwin', w: (c: string, e?: string) => void, rel: string): string {
  setPlatform(platform);
  const d = mkdtempSync(join(tmpdir(), `align-gen-${platform}-`));
  try {
    w(d);
    return readFileSync(join(d, rel), 'utf8');
  } finally {
    rmSync(d, { recursive: true, force: true });
    restorePlatform();
  }
}

describe.each(PLUGINS)('$name spawns something Windows can launch', ({ write, rel }) => {
  it('does not hand a bare "align" to execFile as the command', () => {
    write(dir);
    const src = readFileSync(join(dir, rel), 'utf8');

    // The defect, stated as the thing it produced: `execFile("align", [...])`.
    expect(
      src,
      'a bare "align" as execFile\'s command cannot spawn align.cmd on Windows'
    ).not.toMatch(/execFile\(\s*["']align["']/);
  });

  it('decides the spawn at RUNTIME, so a shared plugin works on any machine', () => {
    write(dir);
    const src = readFileSync(join(dir, rel), 'utf8');

    // The generated code must consult the platform where it RUNS.
    expect(src, 'the generated code must branch on its own process.platform').toContain(
      'process.platform'
    );
    expect(src, 'Windows needs cmd, which resolves align.cmd through PATHEXT').toContain('cmd');
  });

  it('THE DECISIVE ONE: the same bytes are generated on win32, linux and darwin', () => {
    const win = generatedOn('win32', write, rel);
    const lin = generatedOn('linux', write, rel);
    const mac = generatedOn('darwin', write, rel);

    // A generated plugin can be committed, shared or synced to another OS. Baking the
    // GENERATING platform into it works for the author and fails for everyone else.
    expect(win, 'win32 and linux output must not differ').toBe(lin);
    expect(lin, 'linux and darwin output must not differ').toBe(mac);

    // POSITIVE CONTROL: the files are not empty, so "identical" is not two empty strings.
    // Without this, a writer that produced nothing would satisfy every assertion above.
    expect(win.length, 'the generated plugin must have content').toBeGreaterThan(200);
    expect(win).toContain('execFile');
  });

  it('still passes the env through when one is given', () => {
    // A positive control on the parameter the spawn change is most likely to drop: the
    // args array is what gets rewritten, and --env lives in it.
    write(dir, 'preview');
    const src = readFileSync(join(dir, rel), 'utf8');
    expect(src, 'the --env argument must survive the spawn rewrite').toContain('preview');
  });
});
