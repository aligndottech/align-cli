import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => { vi.unstubAllEnvs(); process.exitCode = undefined; });

describe('align config detector', () => {
  it('with no argument, prints the detector in use and where it comes from', async () => {
    vi.stubEnv('ALIGN_DETECTOR', '');
    const text = await run('detector');
    expect(text).toMatch(/Detector: v1 \(default\)/);
    expect(text).toMatch(/align config detector v0/);
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

describe('align config backlog-offer', () => {
  it('reads on by default, and says how to turn it off', async () => {
    vi.stubEnv('ALIGN_NO_BACKLOG_OFFER', '');
    const text = await run('backlog-offer');
    expect(text).toMatch(/Backlog offer: on/); expect(text).toMatch(/align config backlog-offer off/);
  });
  it('off is saved and read back, and on undoes it', async () => {
    expect(await run('backlog-offer', 'off')).toMatch(/Saved: backlog offer off/);
    expect(createConfigStore().getBacklogOffer()).toBe(false);
    expect(await run('backlog-offer')).toMatch(/Backlog offer: off/);
    await run('backlog-offer', 'on');
    expect(createConfigStore().getBacklogOffer()).toBe(true);
  });
  it('rejects anything else without saving it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run('backlog-offer', 'maybe');
    expect(err.mock.calls.join(' ')).toMatch(/"maybe" is not a state/);
    expect(process.exitCode).toBe(1);
    expect(createConfigStore().getBacklogOffer()).toBe(true);
    err.mockRestore();
  });
});
