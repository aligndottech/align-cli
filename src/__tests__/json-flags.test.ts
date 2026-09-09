/**
 * ALI-951: `--json` on the everyday commands (`check`, `ask`; `connect` is covered in
 * connect-command.test.ts) and on the hidden list commands an agent or a script is likely
 * to drive (`decisions list`, `links list`, `export`). One shape per command, one JSON
 * document on stdout, nothing else a parser has to skip.
 */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCheckAlignment = vi.hoisted(() => vi.fn());
const mockSearchDecisions = vi.hoisted(() => vi.fn());
const mockListDecisions = vi.hoisted(() => vi.fn());
const mockListDecisionLinks = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({
    checkAlignment: mockCheckAlignment,
    searchDecisions: mockSearchDecisions,
    listDecisions: mockListDecisions,
    listDecisionLinks: mockListDecisionLinks,
    resolveConflict: vi.fn(),
  })),
}));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })),
    getDefaultEnv: vi.fn(() => 'prod'),
    getConnectorFields: vi.fn(() => null),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({
  resolveEnv: vi.fn((e?: string) => e ?? 'prod'),
  resolveImportEnv: vi.fn((e?: string) => e ?? 'prod'),
}));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('diff --git a/db.ts b/db.ts\n+// use mongodb')),
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
  getGitIdentities: vi.fn(() => Promise.resolve({ email: null, name: null })),
  hasOtherCommitters: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));
const mockSynthesise = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } }));
vi.mock('../lib/local-llm.js', async (importActual) => ({
  ...(await importActual<object>()),
  synthesiseDetailed: mockSynthesise,
}));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage: vi.fn() }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), text: '' })),
}));

import { registerCheckCommand } from '../commands/check.js';
import { registerAskCommand } from '../commands/why.js';
import { registerDecisionsCommand } from '../commands/decisions/index.js';
import { registerLinksCommand } from '../commands/links.js';
import { registerExportCommand } from '../commands/export.js';

const out: string[] = [];
let exitCode: number | undefined;

async function run(register: (p: Command) => void, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

/** Every stdout write, joined, must parse as exactly one JSON document. */
function theOnlyJson(): unknown {
  const text = out.join('');
  expect(text.trim().length, 'nothing was written to stdout').toBeGreaterThan(0);
  return JSON.parse(text);
}

/**
 * `check` calls process.exit inside its try/catch. The real exit never returns; the mocked
 * one throws, the catch writes a second `{status:"error"}` document, so this reads only what
 * a real run prints: the first line.
 */
function firstJsonLine(): unknown {
  const first = out.join('').split('\n')[0] ?? '';
  expect(first.trim().length, 'nothing was written to stdout').toBeGreaterThan(0);
  return JSON.parse(first);
}

describe('--json (ALI-951)', () => {
  beforeEach(() => {
    out.length = 0;
    exitCode = undefined;
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(`${a.join(' ')}\n`); });
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    // The FIRST exit is the one a real run takes; the throw that stands in for it lands in
    // `check`'s catch, which exits again with the transport-failure code (see firstJsonLine).
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { exitCode ??= c; throw new Error(`process.exit(${c})`); }) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('check', () => {
    it('prints the check result as one JSON document, and exits 1 on a conflict', async () => {
      mockCheckAlignment.mockResolvedValue({ status: 'conflicting', confidence: 0.9, relevant_decisions: [], conflicts: [{ decision_id: 'd-1', title: 'Use PostgreSQL', reason: 'MongoDB', severity: 'warning' }], message: 'Conflict' });
      await run(registerCheckCommand, ['check', '--json']);
      expect(firstJsonLine()).toMatchObject({ status: 'conflicting', conflicts: [{ decision_id: 'd-1' }] });
      expect(exitCode).toBe(1);
    });

    it('prints an aligned result and exits 0', async () => {
      mockCheckAlignment.mockResolvedValue({ status: 'aligned', confidence: 0.8, relevant_decisions: [{ id: 'd-2', title: 'Use Postgres' }], conflicts: [], message: 'ok' });
      await run(registerCheckCommand, ['check', '--json']);
      expect(firstJsonLine()).toMatchObject({ status: 'aligned' });
      expect(exitCode).toBe(0);
    });
  });

  describe('ask', () => {
    it('prints the matching decisions as one JSON document, without a prose answer', async () => {
      mockSearchDecisions.mockResolvedValue({ results: [{ id: 'adr-3', title: 'Chose Postgres', summary: 'JSONB', status: 'active', similarity: 0.9 }], count: 1, strategy: 'semantic' });
      await run(registerAskCommand, ['ask', 'why postgres', '--json']);
      expect(theOnlyJson()).toMatchObject({ query: 'why postgres', results: [{ id: 'adr-3', title: 'Chose Postgres' }] });
      expect(mockSynthesise).not.toHaveBeenCalled();
    });

    it('an empty result is an empty array, not the human "build your graph" hint', async () => {
      mockSearchDecisions.mockResolvedValue({ results: [], count: 0, strategy: 'semantic' });
      mockListDecisions.mockResolvedValue([]);
      await run(registerAskCommand, ['ask', 'anything', '--json']);
      expect(theOnlyJson()).toMatchObject({ query: 'anything', results: [] });
      expect(out.join('')).not.toMatch(/align connect|align import/);
    });
  });

  it('decisions list --json prints the rows', async () => {
    mockListDecisions.mockResolvedValue([{ id: 'd-1', title: 'Use PostgreSQL', platform: 'slack', status: 'active' }]);
    await run(registerDecisionsCommand, ['decisions', 'list', '--json']);
    expect(theOnlyJson()).toEqual([{ id: 'd-1', title: 'Use PostgreSQL', platform: 'slack', status: 'active' }]);
  });

  it('links list --json prints the links with their total', async () => {
    mockListDecisionLinks.mockResolvedValue({ links: [{ relation: 'conflicts_with', from_decision: { title: 'a' }, to_decision: { title: 'b' }, confidence: 0.7 }], total_count: 1 });
    await run(registerLinksCommand, ['links', 'list', '--json']);
    expect(theOnlyJson()).toMatchObject({ total_count: 1, links: [{ relation: 'conflicts_with' }] });
  });

  it('export --json is `--format json`', async () => {
    mockListDecisions.mockResolvedValue([{ id: 'd-1', title: 'Use PostgreSQL', summary: 's', platform: 'slack', status: 'active' }]);
    await run(registerExportCommand, ['export', '--json']);
    expect(theOnlyJson()).toMatchObject({ count: 1, decisions: [{ id: 'd-1' }] });
  });
});
