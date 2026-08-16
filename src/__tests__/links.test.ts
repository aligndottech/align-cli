import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mockListDecisionLinks = vi.hoisted(() => vi.fn());

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    listDecisionLinks: mockListDecisionLinks,
  })),
}));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn().mockReturnValue({ gatewayUrl: 'http://localhost', authToken: 'tok' }),
    getDefaultEnv: vi.fn().mockReturnValue('prod'),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));
vi.mock('../lib/table.js', () => ({ renderTable: vi.fn() }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));
vi.spyOn(console, 'log').mockImplementation(() => undefined);

import { registerLinksCommand } from '../commands/links.js';

function makeProgram() {
  const p = new Command();
  p.exitOverride();
  registerLinksCommand(p);
  return p;
}

describe('align links list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders table without crashing when confidence is null', async () => {
    mockListDecisionLinks.mockResolvedValue({ links: [{
      id: 'link-1',
      relation: 'supports',
      confidence: null,
      from_decision: { id: 'd1', title: 'Use Postgres' },
      to_decision: { id: 'd2', title: 'Use pgvector' },
    }], total_count: 1 });
    await expect(
      makeProgram().parseAsync(['node', 'align', 'links', 'list']),
    ).resolves.not.toThrow();
  });

  it('renders table without crashing when confidence is a string (pg numeric)', async () => {
    mockListDecisionLinks.mockResolvedValue({ links: [{
      id: 'link-2',
      relation: 'conflicts_with',
      confidence: '0.87',
      from_decision: { id: 'd1', title: 'Use Postgres' },
      to_decision: { id: 'd2', title: 'Use MySQL' },
    }], total_count: 1 });
    await expect(
      makeProgram().parseAsync(['node', 'align', 'links', 'list']),
    ).resolves.not.toThrow();
  });

  it('formats null confidence as 0.0 in the table row', async () => {
    const { renderTable } = await import('../lib/table.js');
    mockListDecisionLinks.mockResolvedValue({ links: [{
      id: 'link-3',
      relation: 'supports',
      confidence: null,
      from_decision: { id: 'd1', title: 'A' },
      to_decision: { id: 'd2', title: 'B' },
    }], total_count: 1 });
    await makeProgram().parseAsync(['node', 'align', 'links', 'list']);
    const rows = (renderTable as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[][];
    expect(rows[0][3]).toBe('0.0');
  });

  it('says how many links exist beyond the page instead of truncating silently (ALI-587)', async () => {
    mockListDecisionLinks.mockResolvedValue({
      links: [{
        id: 'link-4',
        relation: 'supports',
        confidence: 0.9,
        from_decision: { id: 'd1', title: 'A' },
        to_decision: { id: 'd2', title: 'B' },
      }],
      total_count: 340,
    });
    await makeProgram().parseAsync(['node', 'align', 'links', 'list']);
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes('Showing the first 1 of 340 links'))).toBe(true);
  });

  it('prints no partial-set note when the page holds the whole set', async () => {
    mockListDecisionLinks.mockResolvedValue({
      links: [{
        id: 'link-5',
        relation: 'supports',
        confidence: 0.9,
        from_decision: { id: 'd1', title: 'A' },
        to_decision: { id: 'd2', title: 'B' },
      }],
      total_count: 1,
    });
    await makeProgram().parseAsync(['node', 'align', 'links', 'list']);
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes('Showing the first'))).toBe(false);
  });
});
