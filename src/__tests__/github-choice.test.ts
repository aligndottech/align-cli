import { beforeEach, describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

import { chooseGithubVariant } from '../lib/github-choice.js';

/**
 * ALI-98's real prohibition is a SILENT fallback to a write-capable credential -
 * its GitHub finding was that github-personal "silently falls back to the write bot
 * App". So the write-capable option may exist, but the user must be told what it
 * costs BEFORE choosing it. These tests are that requirement.
 */
describe('chooseGithubVariant', () => {
  beforeEach(() => {
    clack.select.mockReset();
    clack.log.info.mockReset();
    clack.log.warn.mockReset();
    clack.isCancel.mockReturnValue(false);
  });

  it('does not ask at all when only the read-only App is configured', async () => {
    // No choice to make, so no question. A prompt with one real answer is ceremony.
    const v = await chooseGithubVariant({ 'github-app': 'iv1.app' });
    expect(v?.id).toBe('github-app');
    expect(clack.select).not.toHaveBeenCalled();
  });

  it('offers both when both are configured, App first', async () => {
    clack.select.mockResolvedValue('github-app');
    await chooseGithubVariant({ 'github-app': 'a', 'github-oauth': 'b' });
    const opts = clack.select.mock.calls[0]?.[0] as { options: { value: string }[] };
    expect(opts.options.map((o) => o.value)).toEqual(['github-app', 'github-oauth']);
  });

  it('states the write trade-off in the option the user is choosing between', async () => {
    // In the OPTION, not buried in a log line before it - the disclosure has to be
    // where the decision is made, or it is not a disclosure.
    clack.select.mockResolvedValue('github-app');
    await chooseGithubVariant({ 'github-app': 'a', 'github-oauth': 'b' });
    const opts = clack.select.mock.calls[0]?.[0] as { options: { value: string; hint?: string }[] };
    const oauth = opts.options.find((o) => o.value === 'github-oauth');
    expect(oauth?.hint).toMatch(/write/i);
  });

  it('warns again after a write-capable choice is actually made', async () => {
    clack.select.mockResolvedValue('github-oauth');
    const v = await chooseGithubVariant({ 'github-app': 'a', 'github-oauth': 'b' });
    expect(v?.id).toBe('github-oauth');
    const warned = clack.log.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/write/i);
  });

  it('does NOT warn when the read-only App was chosen', async () => {
    // Negative control: proves the warning tracks the choice rather than always firing.
    clack.select.mockResolvedValue('github-app');
    await chooseGithubVariant({ 'github-app': 'a', 'github-oauth': 'b' });
    expect(clack.log.warn).not.toHaveBeenCalled();
  });

  it('returns null when nothing is configured, so setup falls back to the paste', async () => {
    expect(await chooseGithubVariant({})).toBeNull();
  });
});
