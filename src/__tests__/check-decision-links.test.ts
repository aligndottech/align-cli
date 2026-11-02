// `align check` and the advisory text it hands an agent print a link per decision. A seeded decision has
// no source url that opens (the gateway no longer sends its align:// identity), so the link that opens
// (decision_url) must be the one printed, and an align:// value must never be.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { buildAdvisoryOutput, registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod'), resolveImportEnv: vi.fn((e: string) => e ?? 'prod') }));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// retry loop')),
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment })),
}));

async function runCheck(args: string[] = []): Promise<string> {
  const program = new Command();
  registerCheckCommand(program);
  let out = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`exit(${code})`);
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out += `${a.join(' ')}\n`;
  });
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    // process.exit throws
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
    logSpy.mockRestore();
  }
  return out;
}

const SEEDED = 'align://demo/pagewell-pay/engineering/retries-service-owns-retries';
const row = (over: Record<string, unknown>) => ({ id: 'd-1', title: 'Retries service owns retries', summary: 's', similarity: 0.7, ...over });

describe('align check prints a link that opens', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['aligned', { status: 'aligned', confidence: 0.8, relevant_decisions: [row({ decision_url: 'https://app.test/decisions/d-1' })], conflicts: [], message: 'ok' }],
    ['aligned, with the seeded url still present', { status: 'aligned', confidence: 0.8, relevant_decisions: [row({ url: SEEDED, decision_url: 'https://app.test/decisions/d-1' })], conflicts: [], message: 'ok' }],
    ['could not check', { status: 'unknown', reason: 'no_llm_key', confidence: 0, relevant_decisions: [row({ decision_url: 'https://app.test/decisions/d-1' })], conflicts: [], message: 'could not' }],
    [
      'conflicting',
      {
        status: 'conflicting',
        confidence: 0.9,
        relevant_decisions: [row({})],
        conflicts: [{ decision_id: 'd-1', title: 'Retries service owns retries', reason: 'r', severity: 'critical', url: SEEDED, decision_url: 'https://app.test/decisions/d-1' }],
        message: 'conflict',
      },
    ],
  ])('on a %s result', async (_label, result) => {
    mockCheckAlignment.mockResolvedValue(result);
    const out = await runCheck();
    expect(out).toContain('https://app.test/decisions/d-1');
    expect(out).not.toContain('align://');
  });

  it('prints the source url, not the decision link, when there is a real source (as before)', async () => {
    mockCheckAlignment.mockResolvedValue({
      status: 'aligned',
      confidence: 0.8,
      relevant_decisions: [row({ url: 'https://github.com/pagewell-uk/disputes/pull/7', decision_url: 'https://app.test/decisions/d-1' })],
      conflicts: [],
      message: 'ok',
    });
    const out = await runCheck();
    expect(out).toContain('https://github.com/pagewell-uk/disputes/pull/7');
    expect(out).not.toContain('https://app.test/decisions/d-1');
  });
});

describe('the advisory text an agent is handed', () => {
  const opts = { pre: false, format: 'text', blockOnCritical: false } as const;
  const conflict = (over: Record<string, unknown>) => ({ decision_id: 'd-1', title: 'Retries service owns retries', reason: 'r', severity: 'critical', ...over }) as never;

  it('links the decision_url when the conflict has no source url', () => {
    const out = JSON.stringify(buildAdvisoryOutput([conflict({ decision_url: 'https://app.test/decisions/d-1' })], opts));
    expect(out).toContain('(https://app.test/decisions/d-1)');
  });

  it('never prints an align:// url, and falls back to the decision_url', () => {
    const out = JSON.stringify(buildAdvisoryOutput([conflict({ url: SEEDED, decision_url: 'https://app.test/decisions/d-1' })], opts));
    expect(out).not.toContain('align://');
    expect(out).toContain('(https://app.test/decisions/d-1)');
  });

  it('keeps a real source url as it was', () => {
    const out = JSON.stringify(buildAdvisoryOutput([conflict({ url: 'https://github.com/o/r/pull/7', decision_url: 'https://app.test/decisions/d-1' })], opts));
    expect(out).toContain('(https://github.com/o/r/pull/7)');
    expect(out).not.toContain('https://app.test/decisions/d-1');
  });
});
