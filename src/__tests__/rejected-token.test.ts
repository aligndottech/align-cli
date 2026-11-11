import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dropRejectedToken } from '../lib/rejected-token.js';

const forget = vi.fn();
const config = (failed: boolean) => ({
  forgetConnector: (e: string, id: string) => { forget(e, id); return { keychainFailed: failed }; },
  tokenStoreStatus: () => ({ store: 'keychain' as const, label: 'macOS Keychain', reason: null, forced: false }),
});

beforeEach(() => { forget.mockClear(); vi.stubEnv('ALIGN_GITHUB_TOKEN', undefined); });

describe('a saved token the provider rejected', () => {
  it('forgets it and says so', () => {
    const note = dropRejectedToken(config(false), 'github');
    expect(forget).toHaveBeenCalledWith('local', 'github');
    expect(note).toMatch(/Token forgotten/);
  });

  it('does not say it forgot a token the keychain could not delete', () => {
    const note = dropRejectedToken(config(true), 'github');
    expect(note).not.toMatch(/Token forgotten/);
    expect(note).toContain('macOS Keychain');
    expect(note).toMatch(/could not remove/i);
  });

  it('a token that came from the environment is not forgotten: the person is told to unset or replace the variable', () => {
    vi.stubEnv('ALIGN_GITHUB_TOKEN', 'from-the-environment');
    const note = dropRejectedToken(config(false), 'github');
    expect(forget).not.toHaveBeenCalled();
    expect(note).toContain('ALIGN_GITHUB_TOKEN');
    expect(note).not.toMatch(/Token forgotten/);
  });
});
