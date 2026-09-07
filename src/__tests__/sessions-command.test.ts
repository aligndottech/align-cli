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
 *
 * ALI-809 additions (Pass B, free-text):
 * 6. a free-text candidate the model confirms is reviewed and written with the human's own
 *    verbatim text as raw_text (never the model's title in its place)
 * 7. a free-text candidate the model rejects (heuristic misfired) is never presented
 * 8. when nothing survives confirmation, the command says so distinctly from "found nothing"
 * 9. structured and free-text candidates are merged into one sorted review queue - a
 *    free-text candidate timestamped between two structured ones is reviewed in between them
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
const findFreeTextCandidates = vi.hoisted(() => vi.fn().mockReturnValue([]));
vi.mock('../lib/sessions/extract-freetext.js', () => ({ findFreeTextCandidates }));
const confirmFreeTextCandidate = vi.hoisted(() => vi.fn());
vi.mock('../lib/sessions/confirm-freetext.js', () => ({ confirmFreeTextCandidate }));

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
  findFreeTextCandidates.mockReturnValue([]);
  confirmFreeTextCandidate.mockReset();
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

describe('align import sessions: free-text candidates (Pass B)', () => {
  const rawCandidate = {
    agent: 'codex' as const, sessionId: 'sess-2', messageId: 'turn-0',
    humanText: 'We\'re deciding the retry count for failed webhook deliveries.',
    contextText: 'Decision: 3 retries.', timestamp: '2026-09-03T00:00:00.000Z',
  };
  function withOneFreeTextSession() {
    const session = { agent: 'codex' as const, sessionId: 'sess-2', cwd: '/p', turns: [] };
    detectAgents.mockReturnValue([
      { adapter: { agent: 'codex', fixtureVerified: true, locateSessionFiles: () => [], parseSession: () => session }, files: ['/f1.jsonl'] },
    ]);
    findFreeTextCandidates.mockReturnValue([rawCandidate]);
  }

  it('a confirmed free-text candidate is written with the human\'s own verbatim text as raw_text', async () => {
    withOneFreeTextSession();
    confirmFreeTextCandidate.mockResolvedValue({
      ok: true,
      decision: { ...rawCandidate, title: 'Retry count set to 3', confidence: 0.85 },
    });
    runConfirmEachImport.mockImplementation(async (items, onAccept) => {
      await onAccept(items[0]);
      return { imported: 1, skipped: 0, remaining: 0 };
    });

    await run();

    expect(confirmSessionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        source_url: 'codex-session://sess-2/turn-0',
        raw_text: rawCandidate.humanText,
        title: 'Retry count set to 3',
      }),
      'tom@align.tech',
    );
  });

  it('a free-text candidate the model rejects is never presented for review', async () => {
    withOneFreeTextSession();
    confirmFreeTextCandidate.mockResolvedValue({ ok: true, decision: null });

    await run();

    expect(runConfirmEachImport).not.toHaveBeenCalled();
  });

  it('says so distinctly from "found nothing" when candidates existed but none survived confirmation', async () => {
    withOneFreeTextSession();
    confirmFreeTextCandidate.mockResolvedValue({ ok: true, decision: null });

    await run();

    expect(out.join('\n')).toMatch(/confirm/i);
  });

  it('when the LLM is unavailable, the free-text pass is skipped with a message and structured candidates still proceed', async () => {
    const session = { agent: 'claude-code' as const, sessionId: 'sess-1', cwd: '/p', turns: [] };
    detectAgents.mockReturnValue([
      { adapter: { agent: 'claude-code', fixtureVerified: true, locateSessionFiles: () => [], parseSession: () => session }, files: ['/f1.jsonl'] },
    ]);
    extractStructuredDecisions.mockReturnValue([{
      agent: 'claude-code', sessionId: 'sess-1', messageId: 'msg-1',
      question: 'Q?', header: null, options: [{ label: 'A' }], chosenLabel: 'A', timestamp: '2026-09-03T00:00:01.000Z',
    }]);
    findFreeTextCandidates.mockReturnValue([rawCandidate]);
    confirmFreeTextCandidate.mockResolvedValue({ ok: false, reason: 'no_llm_key' });
    runConfirmEachImport.mockImplementation(async (items, onAccept) => {
      await onAccept(items[0]);
      return { imported: 1, skipped: 0, remaining: 0 };
    });

    await run();

    expect(out.join('\n')).toMatch(/no llm|not confirmed|llm configured/i);
    expect(confirmSessionDecision).toHaveBeenCalledWith(expect.objectContaining({ title: 'Q?' }), 'tom@align.tech');
  });

  it('merges structured and free-text candidates into one queue, sorted by timestamp', async () => {
    const session = { agent: 'codex' as const, sessionId: 'sess-3', cwd: '/p', turns: [] };
    detectAgents.mockReturnValue([
      { adapter: { agent: 'codex', fixtureVerified: true, locateSessionFiles: () => [], parseSession: () => session }, files: ['/f1.jsonl'] },
    ]);
    extractStructuredDecisions.mockReturnValue([
      { agent: 'codex', sessionId: 'sess-3', messageId: 'msg-early', question: 'Q1', header: null, options: [], chosenLabel: 'A', timestamp: '2026-09-03T00:00:00.000Z' },
      { agent: 'codex', sessionId: 'sess-3', messageId: 'msg-late', question: 'Q2', header: null, options: [], chosenLabel: 'B', timestamp: '2026-09-03T00:00:02.000Z' },
    ]);
    findFreeTextCandidates.mockReturnValue([{ ...rawCandidate, sessionId: 'sess-3', timestamp: '2026-09-03T00:00:01.000Z' }]);
    confirmFreeTextCandidate.mockResolvedValue({
      ok: true,
      decision: { ...rawCandidate, sessionId: 'sess-3', title: 'middle one', confidence: 0.7, timestamp: '2026-09-03T00:00:01.000Z' },
    });
    const seenTitles: string[] = [];
    runConfirmEachImport.mockImplementation(async (items) => {
      for (const item of items) seenTitles.push(item.render());
      return { imported: 0, skipped: items.length, remaining: 0 };
    });

    await run();

    expect(seenTitles).toHaveLength(3);
    expect(seenTitles[0]).toContain('Q1');
    expect(seenTitles[1]).toContain('middle one');
    expect(seenTitles[2]).toContain('Q2');
  });
});
