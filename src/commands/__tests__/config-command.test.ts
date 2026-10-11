import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../../lib/config.js';
import { registerConfigCommand } from '../config.js';

async function run(...args: string[]): Promise<string> {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  const program = new Command();
  program.exitOverride();
  registerConfigCommand(program);
  await program.parseAsync(['node', 'align', 'config', ...args]);
  log.mockRestore();
  return out.join('\n');
}

// Pin the route too: a hosted key in the developer's shell would make the default v1 (see classifier-route.ts).
beforeEach(() => { for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ALIGN_LLM_API_KEY', 'OPENROUTER_API_KEY']) vi.stubEnv(k, ''); });
afterEach(() => { vi.unstubAllEnvs(); process.exitCode = undefined; });

describe('align config detector', () => {
  it('with no argument, prints the detector in use and where it comes from', async () => {
    vi.stubEnv('ALIGN_DETECTOR', '');
    const text = await run('detector');
    expect(text).toMatch(/Detector: v0 \(default for a local model\)/);
    expect(text).toMatch(/align config detector v1/);
  });

  it('with a version, saves it so the next run reads it', async () => {
    vi.stubEnv('ALIGN_DETECTOR', '');
    const text = await run('detector', 'v1');
    expect(text).toMatch(/Saved: detector v1/);
    expect(createConfigStore().getDetector()).toBe('v1');
  });

  it('rejects an unknown version without saving it', async () => {
    vi.stubEnv('ALIGN_DETECTOR', '');
    const before = createConfigStore().getDetector();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run('detector', 'v9');
    expect(err.mock.calls.join(' ')).toMatch(/"v9" is not a detector/);
    expect(process.exitCode).toBe(1);
    expect(createConfigStore().getDetector()).toBe(before);
    err.mockRestore();
  });

  it('says when ALIGN_DETECTOR overrides the saved choice, instead of looking ignored', async () => {
    vi.stubEnv('ALIGN_DETECTOR', 'v0');
    const text = await run('detector', 'v1');
    expect(text).toMatch(/overrides the saved choice/);
  });
});
