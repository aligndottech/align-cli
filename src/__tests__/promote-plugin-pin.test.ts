// The Claude Code plugin pin (plugins/align) must follow the promoted release. It was a manual step
// after promotion and sat at 0.83.2 for nine releases, so plugin users ran a hook without the
// secret deny. promote-release.yml now opens the pin PR itself; these tests pin that wiring.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; steps: Step[] };
const wf = load(readFileSync(join(root, '.github/workflows/promote-release.yml'), 'utf8')) as { jobs: Record<string, Job> };
const job = wf.jobs['plugin-pin']!;
const stepIndex = (pred: (s: Step) => boolean) => job.steps.findIndex(pred);

describe('promote-release.yml opens the plugin pin PR after a promotion', () => {
  it('runs only after resolve and promote succeed', () => {
    expect(job).toBeDefined();
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).toEqual(expect.arrayContaining(['resolve', 'promote']));
  });

  it('runs only from the default branch, so a dispatch from another ref cannot open a PR from that tree', () => {
    expect(job.if).toMatch(/workflow_run/);
    expect(job.if).toMatch(/github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.['ref']).toBe('${{ github.event.repository.default_branch }}');
    expect(checkout.with?.['persist-credentials']).toBe(false);
  });

  it('mints the release-bot app token only after the repo script has run, and opens the PR with it', () => {
    const sync = stepIndex((s) => /sync-plugin-version/.test(s.run ?? ''));
    const mint = stepIndex((s) => !!s.uses?.startsWith('actions/create-github-app-token@'));
    const open = stepIndex((s) => /gh pr create/.test(s.run ?? ''));
    expect(sync).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(sync);
    expect(open).toBeGreaterThan(mint);
    expect(job.steps[open]!.env?.['GH_TOKEN']).toBe('${{ steps.app-token.outputs.token }}');
    expect(JSON.stringify(job)).not.toMatch(/secrets\.GITHUB_TOKEN/);
  });

  it('pins to the version the decide step accepted, and nothing else', () => {
    const sync = job.steps.find((s) => /sync-plugin-version/.test(s.run ?? ''))!;
    expect(sync.env?.['ALIGN_SYNC_LATEST']).toBe('${{ steps.pin.outputs.version }}');
    expect(sync.if).toMatch(/steps\.pin\.outputs\.go == 'true'/);
  });

  it('re-runs cleanly: the bot branch is force-pushed, so a closed PR or a failed create can be retried', () => {
    const open = job.steps.find((s) => /gh pr create/.test(s.run ?? ''))!;
    expect(open.run).toMatch(/git push --force /);
  });

  it('every run block in the job parses as bash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-wf-'));
    const blocks = job.steps.filter((s) => s.run);
    expect(blocks.length).toBeGreaterThan(2);
    blocks.forEach((s, i) => {
      const f = join(dir, `b${i}.sh`);
      writeFileSync(f, s.run!);
      execFileSync('bash', ['-n', f]);
    });
  });
});

describe('the decide step, run with a stub npm', () => {
  const decide = job.steps.find((s) => s.name === 'Decide the pin')!.run!;
  function run(tag: string, latest: string) {
    const dir = mkdtempSync(join(tmpdir(), 'pin-decide-'));
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho "${latest}"\n`);
    chmodSync(join(dir, 'npm'), 0o755);
    const out = join(dir, 'out');
    writeFileSync(out, '');
    writeFileSync(join(dir, 'decide.sh'), decide);
    const r = spawnSync('bash', [join(dir, 'decide.sh')], {
      env: { ...process.env, PATH: `${dir}:${process.env['PATH']}`, TAG: tag, GITHUB_OUTPUT: out, PIN_RETRY_SLEEP: '0' },
      encoding: 'utf8',
    });
    return { status: r.status, outputs: readFileSync(out, 'utf8'), stdout: r.stdout };
  }

  it('goes when npm latest is the promoted version', () => {
    const r = run('cli-v0.92.0', '0.92.0');
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('version=0.92.0');
    expect(r.outputs).toContain('go=true');
  });

  it('skips, never pins backwards, when latest has moved past the promoted version', () => {
    const r = run('cli-v0.92.0', '0.93.0');
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('go=false');
    expect(r.outputs).not.toContain('version=');
  });

  it('skips when npm returns nothing', () => {
    const r = run('cli-v0.92.0', '');
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('go=false');
  });

  it('stops on a tag that is not a plain X.Y.Z', () => {
    const r = run('cli-v1.2;rm', '1.2;rm');
    expect(r.status).toBe(1);
    expect(r.outputs).toBe('');
  });
});
