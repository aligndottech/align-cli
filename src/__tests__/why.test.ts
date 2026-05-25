import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    searchDecisions: vi.fn().mockResolvedValue({
      results: [
        { id: 'adr-003', title: 'Chose Postgres', summary: 'JSONB and pgvector sealed it.', status: 'active', similarity: 0.91 },
        { id: 'sec-67', title: 'No refresh token DB', summary: 'Client-side only.', status: 'active', similarity: 0.84 },
      ],
      count: 2,
      strategy: 'semantic' as const,
    }),
  })),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn().mockReturnValue({ gatewayUrl: 'http://localhost', authToken: 'tok' }),
    getDefaultEnv: vi.fn().mockReturnValue('prod'),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });

import { registerAskCommand } from '../commands/why.js';

describe('align ask', () => {
  beforeEach(() => { output.length = 0; });
  afterEach(() => vi.clearAllMocks());

  it('calls searchDecisions with normalised query', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','why do we use postgres']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('use postgres', 8);
  });

  it('prints decision titles', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.includes('Chose Postgres'))).toBe(true);
  });

  it('prints decision summaries', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.includes('JSONB and pgvector'))).toBe(true);
  });

  it('prints decision IDs for traceability', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.includes('adr-003'))).toBe(true);
  });

  it('shows no-decisions message when graph is empty', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }),
    });
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','postgres']);
    expect(output.some(l => l.toLowerCase().includes('no decisions found'))).toBe(true);
  });

  it('strips "do we" prefix so query is normalised', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask','do we use postgres']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('use postgres', 8);
  });
});

describe('align ask - file path mode', () => {
  beforeEach(() => { output.length = 0; });
  afterEach(() => vi.clearAllMocks());

  it('detects a file path arg and passes it directly to searchDecisions without normalisation', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'src/auth/middleware.ts']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('src/auth/middleware.ts', 8);
  });

  it('shows "Decisions related to <path>" header for file path queries', async () => {
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'src/auth/middleware.ts']);
    expect(output.some(l => l.includes('Decisions related to') && l.includes('src/auth/middleware.ts'))).toBe(true);
  });

  it('shows file-specific empty state when no decisions found for path', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    (createGatewayClient as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }),
    });
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'src/auth/middleware.ts']);
    expect(output.some(l => l.includes('src/auth/middleware.ts'))).toBe(true);
  });

  it('treats arg with ./ prefix as file path', async () => {
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', './src/auth/middleware.ts']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('./src/auth/middleware.ts', 8);
  });

  it('treats arg as file path when existsSync returns true even with no slash', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    const { createGatewayClient } = await import('../lib/gateway-client.js');
    const program = new Command();
    registerAskCommand(program);
    await program.parseAsync(['node', 'align', 'ask', 'Makefile']);
    const client = (createGatewayClient as ReturnType<typeof vi.fn>).mock.results[0].value as { searchDecisions: ReturnType<typeof vi.fn> };
    expect(client.searchDecisions).toHaveBeenCalledWith('Makefile', 8);
  });
});
