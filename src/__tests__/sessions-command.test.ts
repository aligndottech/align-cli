/**
 * `align import sessions` - orchestration only. The reader/adapters (registry.test.ts,
 * extract-structured.test.ts, the four adapter suites), the confirm-each loop
 * (personal-import-confirm-each.test.ts) and the write path
 * (local-gateway-client-confirm.test.ts) each have their own suite; this one mocks all of
 * them and tests only what sessions.ts itself decides.
 *
 * Test List:
 * 1. a non-local environment refuses with a clear message and never detects/prompts
 * 2. no agent has any local session data: says so, exits 0, without prompting
 * 3. a detected but unverified adapter (fixtureVerified: false) warns by name and is
 *    excluded from extraction - the other detected agents still proceed
 * 4. candidates found: extraction runs per detected+parseable session, confirm-each is
 *    called with one item per candidate, and accepting calls confirmSessionDecision with
 *    the session's source_url scheme and the resolved identity
 * 5. the identity comes from git config, falling back to the OS user (same rule as ratify)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type NodeOs from 'node:os';

vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn() })),
}));
const resolveImportEnv = vi.hoisted(() => vi.fn().mockReturnValue('local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveImportEnv }));
const getEnvironment = vi.hoisted(() => vi.fn().mockReturnValue({ mode: 'local-embedded', localDbPath: '/tmp/x.db' }));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment })) }));
const getGitIdentity = vi.hoisted(() => vi.fn());
vi.mock('../lib/git.js', () => ({ getGitIdentity }));
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>();
  // sessions.ts uses the DEFAULT import (`import os from 'node:os'`), so the override has
  // to land on `default.userInfo`, not just a named export - vitest does not compose those
  // for a core-module mock automatically.
  const mocked = { ...original, userInfo: () => ({ username: 'os-fallback-user' }) };
  return { ...mocked, default: mocked };
});

const detectAgents = vi.hoisted(() => vi.fn().mockReturnValue([]));
vi.mock('../lib/sessions/registry.js', () => ({ detectAgents }));
const extractStructuredDecisions = vi.hoisted(() => vi.fn().mockReturnValue([]));
vi.mock('../lib/sessions/extract-structured.js', () => ({ extractStructuredDecisions }));

const confirmSessionDecision = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'd1', title: 't', confirmedBy: 'x', confirmedAt: 'now' }));
const localClose = vi.hoisted(() => vi.fn());
vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn(() => ({ confirmSessionDecision, close: localClose })),
}));

const runConfirmEachImport = vi.hoisted(() => vi.fn().mockResolvedValue({ imported: 0, skipped: 0, remaining: 0 }));
vi.mock('../lib/personal-import.js', () => ({ runConfirmEachImport }));

import { registerImportSessionsCommand } from '../commands/import/sessions.js';

const out: string[] = [];
const err: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
let exitCode: number | undefined;
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  exitCode = code;
  throw new Error(`process.exit(${code})`);
}) as never);

async function run(): Promise<void> {
  out.length = 0; err.length = 0; exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  const importCmd = program.command('import');
  registerImportSessionsCommand(importCmd);
  try {
    await program.parseAsync(['node', 'align', 'import', 'sessions']);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

beforeEach(() => {
  getEnvironment.mockReturnValue({ mode: 'local-embedded', localDbPath: '/tmp/x.db' });
  detectAgents.mockReturnValue([]);
  extractStructuredDecisions.mockReturnValue([]);
  confirmSessionDecision.mockReset().mockResolvedValue({ id: 'd1', title: 't', confirmedBy: 'x', confirmedAt: 'now' });
  runConfirmEachImport.mockReset().mockResolvedValue({ imported: 0, skipped: 0, remaining: 0 });
  getGitIdentity.mockReset().mockResolvedValue('tom@align.tech');
});

describe('align import sessions: environment', () => {
  it('refuses a non-local environment with a clear message, and never detects or prompts', async () => {
    getEnvironment.mockReturnValue({ mode: 'cloud' });
    await run();
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/local/i);
    expect(detectAgents).not.toHaveBeenCalled();
    expect(runConfirmEachImport).not.toHaveBeenCalled();
  });
});

describe('align import sessions: nothing found', () => {
  it('says so and exits cleanly when no agent has any local session data', async () => {
    detectAgents.mockReturnValue([]);
    await run();
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toMatch(/no.*session/i);
    expect(runConfirmEachImport).not.toHaveBeenCalled();
  });
});

describe('align import sessions: unverified adapters', () => {
  it('warns by name and excludes an unverified adapter, while a verified one still proceeds', async () => {
    const verifiedSession = { agent: 'claude-code', sessionId: 's1', cwd: '/p', turns: [] };
    detectAgents.mockReturnValue([
      { adapter: { agent: 'cursor', fixtureVerified: false, locateSessionFiles: () => [], parseSession: () => { throw new Error('should not be called'); } }, files: ['/f1.jsonl'] },
      { adapter: { agent: 'claude-code', fixtureVerified: true, locateSessionFiles: () => [], parseSession: () => verifiedSession }, files: ['/f2.jsonl'] },
    ]);
    extractStructuredDecisions.mockReturnValue([]);
    await run();
    expect(out.join('\n')).toMatch(/cursor/i);
    expect(extractStructuredDecisions).toHaveBeenCalledWith(verifiedSession);
  });
});

describe('align import sessions: candidates found', () => {
  it('reviews one item per candidate and accepting writes via confirmSessionDecision with the source_url scheme', async () => {
    const session = { agent: 'claude-code' as const, sessionId: 'sess-1', cwd: '/p', turns: [] };
    detectAgents.mockReturnValue([
      { adapter: { agent: 'claude-code', fixtureVerified: true, locateSessionFiles: () => [], parseSession: () => session }, files: ['/f1.jsonl'] },
    ]);
    extractStructuredDecisions.mockReturnValue([{
      agent: 'claude-code', sessionId: 'sess-1', messageId: 'msg-1',
      question: 'How do you want the fix handled?', header: 'h',
      options: [{ label: 'Fold it in' }], chosenLabel: 'Fold it in', timestamp: '2026-09-03T00:00:00.000Z',
    }]);
    runConfirmEachImport.mockImplementation(async (items, onAccept) => {
      await onAccept(items[0]);
      return { imported: 1, skipped: 0, remaining: 0 };
    });

    await run();

    expect(confirmSessionDecision).toHaveBeenCalledWith(
      expect.objectContaining({ source_url: 'claude-code-session://sess-1/msg-1', title: 'How do you want the fix handled?' }),
      'tom@align.tech',
    );
  });
});

describe('align import sessions: identity resolution', () => {
  it('falls back to the OS user when git identity is unavailable', async () => {
    getGitIdentity.mockResolvedValue(null);
    const session = { agent: 'claude-code' as const, sessionId: 'sess-1', cwd: '/p', turns: [] };
    detectAgents.mockReturnValue([
      { adapter: { agent: 'claude-code', fixtureVerified: true, locateSessionFiles: () => [], parseSession: () => session }, files: ['/f1.jsonl'] },
    ]);
    extractStructuredDecisions.mockReturnValue([{
      agent: 'claude-code', sessionId: 'sess-1', messageId: 'msg-1',
      question: 'Q?', header: null, options: [{ label: 'A' }], chosenLabel: 'A', timestamp: null,
    }]);
    runConfirmEachImport.mockImplementation(async (items, onAccept) => {
      await onAccept(items[0]);
      return { imported: 1, skipped: 0, remaining: 0 };
    });

    await run();

    expect(confirmSessionDecision).toHaveBeenCalledWith(expect.anything(), 'os-fallback-user');
  });
});
