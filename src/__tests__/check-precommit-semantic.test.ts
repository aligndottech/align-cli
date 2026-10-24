/**
 * Semantic conflicts are stopped at the git pre-commit door (`check --hook`), which
 * can wait for the full check. Pair: critical refuses the commit citing the decision, a
 * warning lets it through. The check-could-not-run case is pinned in check-unknown.test.ts
 * (allowed, and never silent): a hook that refuses whenever a provider is down gets removed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({
  resolveEnv: vi.fn((e: string) => e ?? 'prod'),
  resolveImportEnv: vi.fn((e: string) => e ?? 'prod'),
}));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// use mongodb')),
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })),
}));

const conflicting = (severity: 'critical' | 'warning') => ({
  status: 'conflicting',
  confidence: 0.9,
  relevant_decisions: [],
  conflicts: [{ decision_id: 'd-1', title: 'Use Postgres for persistence', reason: 'Reverses the datastore decision', severity }],
});

async function runHook(): Promise<{ exitCode: number | undefined; out: string }> {
  const program = new Command();
  registerCheckCommand(program);
  let exitCode: number | undefined;
  let out = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCode ??= code ?? 0;
    throw new Error(`exit(${code})`);
  });
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`));
  try {
    await program.parseAsync(['node', 'align', 'check', '--hook']);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    log.mockRestore();
  }
  return { exitCode, out };
}

beforeEach(() => vi.clearAllMocks());

describe('pre-commit (check --hook) on a semantic conflict', () => {
  it('refuses the commit on a critical conflict, citing the decision', async () => {
    mockCheckAlignment.mockResolvedValue(conflicting('critical'));
    const { exitCode, out } = await runHook();
    expect(exitCode).toBe(1);
    expect(out).toContain('Use Postgres for persistence');
  });

  it('lets the commit through on a warning-level conflict, and still prints it', async () => {
    mockCheckAlignment.mockResolvedValue(conflicting('warning'));
    const { exitCode, out } = await runHook();
    expect(exitCode).toBe(0);
    expect(out).toContain('Use Postgres for persistence');
  });
});
