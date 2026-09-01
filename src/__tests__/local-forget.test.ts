import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const { mockForgetConnector, mockForgetAllConnectors, mockGetConnectorFields } = vi.hoisted(() => ({
  mockForgetConnector: vi.fn(),
  mockForgetAllConnectors: vi.fn(),
  mockGetConnectorFields: vi.fn().mockReturnValue(null),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn().mockReturnValue({
    forgetConnector: mockForgetConnector,
    forgetAllConnectors: mockForgetAllConnectors,
    getConnectorFields: mockGetConnectorFields,
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
 * without the command would be the same defect this change set out to fix (ALI-802): the
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
