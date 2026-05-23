import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock clack/prompts so confirm always returns true without TTY
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Mock ora so we don't render spinners in tests
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

// Silence console output
const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

import type { PersonalImportItem } from '../lib/personal-import.js';
import { runPersonalImport } from '../lib/personal-import.js';
import type { createGatewayClient } from '../lib/gateway-client.js';

function makeClient(override?: Partial<ReturnType<typeof createGatewayClient>>): ReturnType<typeof createGatewayClient> {
  return {
    ingestBatch: vi.fn().mockResolvedValue({ snapshots: [{ id: '1', title: 'T', summary: 'S' }] }),
    ...override,
  } as unknown as ReturnType<typeof createGatewayClient>;
}

function makeItems(count: number): PersonalImportItem[] {
  return Array.from({ length: count }, (_, i) => ({
    source_url: `https://example.com/item-${i}`,
    platform: 'git',
    raw_text: `Item ${i} description`,
    title: `Item ${i}`,
  }));
}

describe('runPersonalImport', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('warns and returns when items list is empty', async () => {
    const { log } = await import('@clack/prompts');
    const client = makeClient();
    await runPersonalImport([], client, { label: 'test', approve: true, appUrl: 'http://app' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No items found'));
    expect(client.ingestBatch).not.toHaveBeenCalled();
  });

  it('chunks 45 items into 3 batches (20, 20, 5)', async () => {
    const client = makeClient();
    await runPersonalImport(makeItems(45), client, { label: 'test', approve: true, appUrl: 'http://app' });
    expect(client.ingestBatch).toHaveBeenCalledTimes(3);
    expect((client.ingestBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(20);
    expect((client.ingestBatch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toHaveLength(20);
    expect((client.ingestBatch as ReturnType<typeof vi.fn>).mock.calls[2][0]).toHaveLength(5);
  });

  it('sends exactly 1 batch for 20 items', async () => {
    const client = makeClient();
    await runPersonalImport(makeItems(20), client, { label: 'test', approve: true, appUrl: 'http://app' });
    expect(client.ingestBatch).toHaveBeenCalledTimes(1);
  });

  it('continues after a batch failure', async () => {
    const ingestBatch = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({ snapshots: [{ id: '1', title: 'T', summary: 'S' }] });
    const client = makeClient({ ingestBatch });
    await runPersonalImport(makeItems(25), client, { label: 'test', approve: true, appUrl: 'http://app' });
    expect(ingestBatch).toHaveBeenCalledTimes(2);
  });

  it('skips confirmation when approve flag is set', async () => {
    const { confirm } = await import('@clack/prompts');
    const client = makeClient();
    await runPersonalImport(makeItems(5), client, { label: 'test', approve: true, appUrl: 'http://app' });
    expect(confirm).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    consoleLog.mockClear();
  });
});
