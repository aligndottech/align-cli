import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const { mockGetConnectorFields, localDb } = vi.hoisted(() => ({
  mockGetConnectorFields: vi.fn().mockReturnValue(null),
  localDb: {
    getStats: vi.fn(() => ({ decisions: 3 })),
    listLinks: vi.fn(() => []),
    getAllRefs: vi.fn(() => []),
    close: vi.fn(),
  },
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn().mockReturnValue({
    getEnvironment: vi.fn().mockReturnValue({ mode: 'local-embedded', localDbPath: '/tmp/test.db' }),
    getConnectorFields: mockGetConnectorFields,
  }),
}));

vi.mock('../lib/local-db.js', () => ({
  createLocalDb: vi.fn(() => localDb),
}));

import { registerLocalCommand } from '../commands/local.js';

const output: string[] = [];

/**
 * `align local status` shares its rollup and readout with `align status` (ALI-505), so
 * this only pins the piece that is new here: the gap-driven pull (ALI-796) - the same
 * behaviour, wired through the OTHER command that reads the local graph.
 */
describe('align local status names its own gaps (ALI-796)', () => {
  const run = (args: string[]) => {
    const program = new Command();
    registerLocalCommand(program);
    return program.parseAsync(['node', 'align', ...args]);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    output.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a) => { output.push(a.join(' ')); });
    mockGetConnectorFields.mockReturnValue(null);
    localDb.getStats.mockReturnValue({ decisions: 3 });
    localDb.listLinks.mockReturnValue([]);
    localDb.getAllRefs.mockReturnValue([]);
  });

  const plain = () => output.join('\n').replace(/\[[0-9;]*m/g, '');

  it('names an unresolved-ref gap and the command that fills it in', async () => {
    localDb.getAllRefs.mockReturnValue([{ decisionId: 'a', ref: 'ALI-1', platform: 'jira' }]);

    await run(['local', 'status']);

    expect(plain()).toContain("1 decision cites Jira I can't read - align import jira");
  });

  it('says nothing once the connector is connected', async () => {
    localDb.getAllRefs.mockReturnValue([{ decisionId: 'a', ref: 'ALI-1', platform: 'jira' }]);
    mockGetConnectorFields.mockImplementation((_env: string, id: string) => (id === 'jira' ? { token: 'x' } : null));

    await run(['local', 'status']);

    expect(plain()).not.toMatch(/I can't read/);
  });
});
