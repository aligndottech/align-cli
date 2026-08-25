/**
 * The mirror that publishes this action to aligndottech/decision-check.
 *
 * Marketplace requires action.yml at a repository ROOT, so an action in .github/actions/
 * can never be listed and the published repo has to be a copy (ALI-686). A copy step is
 * the classic place for a silent miss: a rewrite that matches nothing exits 0, and the
 * result is a README telling strangers to depend on a path that cannot be listed.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const ACTION_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/align-check');
const SCRIPT = join(ACTION_DIR, 'mirror.sh');

// A missing subject is a hard failure, never a suite of passes against nothing.
if (!existsSync(SCRIPT)) throw new Error(`FATAL: ${SCRIPT} is missing`);

async function mirror(ref = 'v2'): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), 'align-mirror-'));
  await exec('bash', [SCRIPT, dest, ref]);
  return dest;
}

describe('mirror.sh', () => {
  it('copies every file the action needs at runtime', async () => {
    const dest = await mirror();
    // annotate.mjs and decide.sh are resolved through ${{ github.action_path }}, so the
    // published copy is broken in a way no syntax check would catch if either is missing.
    for (const f of ['action.yml', 'decide.sh', 'annotate.mjs', 'README.md', 'LICENSE']) {
      expect(existsSync(join(dest, f)), `${f} missing from the mirror`).toBe(true);
    }
  });

  it('ships a licence, because the published repo had none', async () => {
    const dest = await mirror();
    expect(readFileSync(join(dest, 'LICENSE'), 'utf8')).toContain('MIT License');
  });

  it('points the README at the published repo, not at this subdirectory', async () => {
    const dest = await mirror('v2');
    const readme = readFileSync(join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('aligndottech/decision-check@v2');
    expect(readme).not.toContain('aligndottech/align-cli/.github/actions/align-check@main');
  });

  it('carries the ref through rather than hardcoding one', async () => {
    const dest = await mirror('v3.1.4');
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('aligndottech/decision-check@v3.1.4');
  });

  // The control that matters: prove the rewrite FAILS LOUDLY when it matches nothing.
  // Without this, a README rename turns the rewrite into a no-op that still exits 0 and
  // publishes instructions pointing at an unlistable path.
  it('fails when there is nothing to rewrite, instead of silently publishing', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'align-mirror-'));
    const readmePath = join(ACTION_DIR, 'README.md');
    const original = readFileSync(readmePath, 'utf8');
    // Asserting on the stderr TEXT, not merely that it rejected: a bare rejection is
    // satisfied by mirror.sh being deleted, a bad interpreter, or any other error, so it
    // would pass while proving nothing about the guard it is here to pin.
    let exitedZero = false;
    try {
      writeFileSync(readmePath, '# no uses references here\n');
      await exec('bash', [SCRIPT, dest, 'v2']);
      exitedZero = true;
    } catch (err) {
      const e = err as { stderr?: unknown };
      expect(String(e.stderr ?? '')).toContain(
        "found no 'aligndottech/align-cli/.github/actions/align-check@main' references to rewrite",
      );
    } finally {
      // cp semantics, not git checkout: restoring from HEAD would discard any other
      // uncommitted edit to this README.
      writeFileSync(readmePath, original);
    }
    expect(exitedZero, 'mirror.sh exited 0 with nothing to rewrite').toBe(false);
    expect(readFileSync(readmePath, 'utf8')).toBe(original);
  });
});
