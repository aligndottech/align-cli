import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const { mockForgetConnector, mockForgetAllConnectors, mockGetConnectorFields, mockHasStoredToken } = vi.hoisted(() => ({
  mockHasStoredToken: vi.fn().mockReturnValue(false),
  mockForgetConnector: vi.fn(),
  mockForgetAllConnectors: vi.fn(),
  mockGetConnectorFields: vi.fn().mockReturnValue(null),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn().mockReturnValue({
    forgetConnector: mockForgetConnector,
    forgetAllConnectors: mockForgetAllConnectors,
    getConnectorFields: mockGetConnectorFields,
    hasStoredToken: mockHasStoredToken,
    isConnected: vi.fn().mockReturnValue(false),
    tokenStoreStatus: vi.fn().mockReturnValue({ store: 'keychain', label: 'macOS Keychain', reason: null, forced: false }),
    getEnvironment: vi.fn().mockReturnValue({ mode: 'local-embedded', localDbPath: '/tmp/test.db' }),
    setLocalMode: vi.fn(),
    clearLocalMode: vi.fn(),
  }),
}));

vi.mock('../lib/local-db.js', () => ({
  createLocalDb: vi.fn().mockReturnValue({ dropAll: vi.fn(), close: vi.fn() }),
}));

import { registerLocalCommand } from '../commands/local.js';

/**
 * `align local forget` exists because setup's own copy promises it. Shipping the sentence
 * without the command would be the same defect this change set out to fix: the
 * interface claiming something the code does not do.
 */
describe('align local forget', () => {
  const run = (args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerLocalCommand(program);
    return program.parseAsync(['node', 'align', ...args]);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConnectorFields.mockReturnValue(null);
    // A saved token is recorded whenever the test says the connector has fields, unless a test says otherwise.
    mockHasStoredToken.mockImplementation((_e: string, c: string) => Boolean(mockGetConnectorFields('local', c)));
    mockForgetConnector.mockReturnValue({ keychainFailed: false });
    mockForgetAllConnectors.mockReturnValue({ keychainFailed: false });
    vi.stubEnv('ALIGN_GITHUB_TOKEN', undefined);
    process.exitCode = undefined;
  });

  describe('the OS keychain and the environment', () => {
    it('forgets a token only the keychain holds, even when it cannot be read right now', async () => {
      mockGetConnectorFields.mockReturnValue(null);
      mockHasStoredToken.mockReturnValue(true);
      await run(['local', 'forget', 'github']);
      expect(mockForgetConnector).toHaveBeenCalledWith('local', 'github');
    });

    it('with only an environment variable and nothing saved, says there was nothing saved and that the variable keeps it connected', async () => {
      vi.stubEnv('ALIGN_GITHUB_TOKEN', 'from-the-environment');
      mockGetConnectorFields.mockReturnValue({ token: 'from-the-environment' });
      mockHasStoredToken.mockReturnValue(false);
      const c = capture();
      await run(['local', 'forget', 'github']);
      c.restore();
      expect(mockForgetConnector).not.toHaveBeenCalled();
      expect(c.out.join('\n')).toMatch(/Nothing saved for github/);
      expect(c.out.join('\n')).toContain('ALIGN_GITHUB_TOKEN');
    });

    const capture = () => {
      const out: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
      const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
      return { out, restore: () => { log.mockRestore(); err.mockRestore(); } };
    };

    it('does not claim a clean removal when the keychain could not delete the token', async () => {
      mockGetConnectorFields.mockReturnValue({ token: 'ghp_saved' });
      mockForgetConnector.mockReturnValue({ keychainFailed: true });
      const c = capture();
      await run(['local', 'forget', 'github']);
      c.restore();
      expect(c.out.join('\n')).toMatch(/could not remove/i);
      expect(c.out.join('\n')).toContain('macOS Keychain');
      expect(process.exitCode).toBe(1);
    });

    it('does the same for forget with no argument', async () => {
      mockForgetAllConnectors.mockReturnValue({ keychainFailed: true });
      const c = capture();
      await run(['local', 'forget']);
      c.restore();
      expect(c.out.join('\n')).toMatch(/could not remove/i);
      expect(process.exitCode).toBe(1);
    });

    it('says the environment variable keeps the source connected when it is still set', async () => {
      vi.stubEnv('ALIGN_GITHUB_TOKEN', 'from-the-environment');
      mockGetConnectorFields.mockReturnValue({ token: 'from-the-environment' });
      const c = capture();
      await run(['local', 'forget', 'github']);
      c.restore();
      expect(c.out.join('\n')).toContain('ALIGN_GITHUB_TOKEN');
    });

    it('does not mention the variable when it is unset', async () => {
      mockGetConnectorFields.mockReturnValue({ token: 'ghp_saved' });
      const c = capture();
      await run(['local', 'forget', 'github']);
      c.restore();
      expect(c.out.join('\n')).not.toContain('ALIGN_GITHUB_TOKEN');
    });
  });

  it('forgets every saved connector when given no argument', async () => {
    await run(['local', 'forget']);

    expect(mockForgetAllConnectors).toHaveBeenCalledWith('local');
  });

  it('forgets one named connector without touching the rest', async () => {
    // The precondition is the saved credential: without it the command correctly takes its
    // "nothing saved" branch, and the assertion below would be measuring the wrong path.
    mockGetConnectorFields.mockReturnValue({ token: 'ghp_saved' });

    await run(['local', 'forget', 'github']);

    expect(mockForgetConnector).toHaveBeenCalledWith('local', 'github');
    expect(mockForgetAllConnectors).not.toHaveBeenCalled();
  });

  it('reports what it removed, naming the connector', async () => {
    const said: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });

    mockGetConnectorFields.mockReturnValue({ token: 'ghp_saved' });
    await run(['local', 'forget', 'github']);
    spy.mockRestore();

    expect(said.join('\n')).toMatch(/github/i);
  });

  // Silence on a no-op reads as success, and the user then believes a credential is gone when
  // nothing was ever stored. Saying "nothing saved" is a different message from "removed".
  it('says so when there was nothing saved to remove', async () => {
    const said: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });

    mockGetConnectorFields.mockReturnValue(null);
    await run(['local', 'forget', 'github']);
    spy.mockRestore();

    expect(said.join('\n')).toMatch(/nothing saved|no saved/i);
  });
});
