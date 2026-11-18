/**
 * `align check --decisions-file <file>`: judge the diff against the decisions in a committed file
 * (DECISIONS.md, from `align up --out`), with the user's own provider key and no graph.
 *
 * The provider is the only fake: the file parser, the prompt, the shared v1 set classifier and its
 * deterministic resolver are all real. What these tests pin is the CI contract: exit 1 for a
 * conflict, exit 2 for every way the check could not run, and never 0 for a check that did not look.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { renderDecisionsFile } from '../lib/decisions-context.js';
import type * as LocalLlm from '../lib/local-llm.js';

const mockGraphCheck = vi.fn();
const mockProvider = vi.fn();
const mockHasProvider = vi.fn();
const mockGetBaseDiff = vi.fn();

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: undefined, mode: 'auth' })),
    getDetector: vi.fn(() => undefined),
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod'), resolveImportEnv: vi.fn((e: string) => e ?? 'prod') }));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('')),
  getHeadDiff: vi.fn(() => Promise.resolve('')),
  getBaseDiff: (...a: unknown[]) => mockGetBaseDiff(...a),
  getCurrentBranch: vi.fn(() => Promise.resolve('feat/test')),
}));
// The graph client is wired to fail the test if the decisions-file path ever reaches it.
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockGraphCheck })),
}));
// The provider boundary, and nothing else.
vi.mock('../lib/local-llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalLlm>()),
  callChatDetailed: (...a: unknown[]) => mockProvider(...a),
  hasConfiguredProvider: () => mockHasProvider(),
  probeOllama: vi.fn(() => Promise.resolve(null)),
}));

const dir = mkdtempSync(join(tmpdir(), 'align-check-decisions-file-'));
const DECISIONS = renderDecisionsFile([
  { title: 'Use PostgreSQL for all persistent data', cite: 'acme/app#7', sourceUrl: 'https://github.com/acme/app/pull/7', reason: 'One database to back up and operate.', kind: 'rule' },
  { title: 'Never call the network from a unit test', cite: 'acme/app#12', kind: 'decision' },
]);
const decisionsPath = join(dir, 'DECISIONS.md');
writeFileSync(decisionsPath, DECISIONS);

const PR_DIFF = 'diff --git a/db.ts b/db.ts\n+// switch the orders table to mongodb';

const verdict = (ref: number) => ({
  relationships: { similar: [{ decision_ref: ref, type: 'incompatible', confidence: 0.95, evidence: { new_quote: 'switch the orders table to mongodb', existing_quote: 'Use PostgreSQL for all persistent data' }, replaced: 'new', reasons: ['The diff moves data to MongoDB, which the decision rules out.'] }] },
});
const clean = { relationships: { similar: [] } };
const answer = (body: unknown) => mockProvider.mockResolvedValue({ ok: true, text: JSON.stringify(body) });
const promptOf = (): string => {
  const u = mockProvider.mock.calls[0]![1] as string | ((w: number) => string);
  return typeof u === 'function' ? u(200_000) : u;
};

async function runCheck(args: string[]): Promise<{ exitCode: number | undefined; stdout: string; console: string; stderr: string }> {
  const program = new Command();
  registerCheckCommand(program);
  const exitCodes: number[] = [];
  let stdout = '';
  let consoleOut = '';
  let stderr = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error(`exit(${code})`);
  }) as never);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { stdout += String(c); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { stderr += String(c); return true; });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { consoleOut += `${a.join(' ')}\n`; });
  const errLogSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { consoleOut += `${a.join(' ')}\n`; });
  try {
    await program.parseAsync(['node', 'align', 'check', ...args]);
  } catch {
    // process.exit throws to stop execution
  } finally {
    exitSpy.mockRestore(); writeSpy.mockRestore(); errSpy.mockRestore(); logSpy.mockRestore(); errLogSpy.mockRestore();
  }
  return { exitCode: exitCodes[0], stdout, console: consoleOut, stderr };
}
const ciArgs = (file = decisionsPath) => ['--ci', '--base', 'origin/main', '--decisions-file', file];
// The FIRST line: the spy's process.exit throws into the command's own catch, which a real exit never returns to.
const json = (r: { stdout: string }) => JSON.parse(r.stdout.trim().split('\n')[0]!) as Record<string, unknown> & { conflicts?: Array<Record<string, unknown>> };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ALIGN_DETECTOR', 'v1');
  mockGetBaseDiff.mockResolvedValue(PR_DIFF);
  mockHasProvider.mockReturnValue(true);
  answer(clean);
});
afterEach(() => vi.unstubAllEnvs());

describe('--decisions-file: a conflict', () => {
  it('the provider names decision 1 as incompatible -> exit 1, JSON status conflicting, that decision cited', async () => {
    answer(verdict(1));
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(1);
    const out = json(r);
    expect(out['status']).toBe('conflicting');
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts![0]).toMatchObject({ title: 'Use PostgreSQL for all persistent data', severity: 'critical', url: 'https://github.com/acme/app/pull/7' });
    expect(String(out.conflicts![0]!['reason'])).toContain('MongoDB');
  });

  it('naming decision 2 instead cites decision 2, so the answer is read from the model and not fixed', async () => {
    answer(verdict(2));
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(1);
    expect(json(r).conflicts![0]).toMatchObject({ title: 'Never call the network from a unit test' });
  });

  it('prints the conflict for a person and exits 1 outside --ci too', async () => {
    answer(verdict(1));
    const r = await runCheck(['--base', 'origin/main', '--decisions-file', decisionsPath]);
    expect(r.exitCode).toBe(1);
    expect(r.console).toContain('Use PostgreSQL for all persistent data');
  });
});

describe('--decisions-file: aligned', () => {
  it('the provider finds no relationship -> exit 0 and status aligned', async () => {
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(0);
    expect(json(r)['status']).toBe('aligned');
  });

  it('the provider was asked about the diff and about EVERY decision, with its reason (so a clean verdict means something)', async () => {
    await runCheck(ciArgs());
    expect(mockProvider).toHaveBeenCalledTimes(1);
    const prompt = promptOf();
    expect(prompt).toContain('switch the orders table to mongodb');
    expect(prompt).toContain('Use PostgreSQL for all persistent data');
    expect(prompt).toContain('One database to back up and operate.');
    expect(prompt).toContain('Never call the network from a unit test');
  });

  it('--title is what the provider is told is being decided', async () => {
    await runCheck([...ciArgs(), '--title', 'Move orders to Mongo']);
    expect(promptOf()).toContain('Move orders to Mongo');
  });

  it('never touches the decision graph', async () => {
    answer(verdict(1));
    const r = await runCheck(ciArgs());
    // Positive control: the check did run and judge (a graph that is never reached because
    // nothing ran at all would pass the next line too).
    expect(r.exitCode).toBe(1);
    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(mockGraphCheck).not.toHaveBeenCalled();
  });
});

describe('--decisions-file: never opens the graph', () => {
  it('a graph client that cannot be built (an unopenable local database) does not stop a file check', async () => {
    vi.mocked(createGatewayClient).mockImplementationOnce(() => { throw new Error('unable to open database file'); });
    answer(verdict(1));
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(1);
    expect(json(r)['status']).toBe('conflicting');
  });
});

describe('--decisions-file: fails closed (exit 2, never 0)', () => {
  it('no provider key: unknown / no_llm_key, naming the fix', async () => {
    mockHasProvider.mockReturnValue(false);
    mockProvider.mockResolvedValue({ ok: false, failure: { kind: 'no_provider' } });
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(2);
    expect(json(r)).toMatchObject({ status: 'unknown', reason: 'no_llm_key' });
    expect(String(json(r)['message'])).toContain('OPENAI_API_KEY');
  });

  it('the provider is rejected (a bad key, a 401) -> exit 2', async () => {
    mockProvider.mockResolvedValue({ ok: false, failure: { kind: 'provider_stopped', provider: 'openai', model: 'gpt-4o-mini', detail: 'HTTP 401' } });
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(2);
    expect(json(r)['status']).toBe('unknown');
  });

  it('the provider answers with no JSON -> exit 2, not "no conflicts"', async () => {
    mockProvider.mockResolvedValue({ ok: true, text: 'Looks fine to me!' });
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(2);
    expect(json(r)).toMatchObject({ status: 'unknown', reason: 'classifier_unparseable' });
  });

  it('a non-empty answer in which no entry names a decision is unreadable (exit 2), not "aligned"', async () => {
    answer({ relationships: { similar: [null] } });
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(2);
    expect(json(r)).toMatchObject({ status: 'unknown', reason: 'classifier_unparseable' });
  });

  it('an entry naming a decision outside the file is not a judgement of any of them (exit 2)', async () => {
    answer(verdict(9));
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(2);
  });

  it('the provider call throws -> exit 2 with status error', async () => {
    mockProvider.mockRejectedValue(new Error('socket hang up'));
    const r = await runCheck(ciArgs());
    expect(r.exitCode).toBe(2);
    expect(json(r)['status']).toBe('error');
  });

  it('a file that is not there -> exit 2, and the provider is never asked', async () => {
    const r = await runCheck(ciArgs(join(dir, 'nope.md')));
    expect(r.exitCode).toBe(2);
    expect(json(r)).toMatchObject({ status: 'unknown', reason: 'decisions_file_unreadable' });
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('a non-empty file with no decisions in it -> exit 2, and the provider is never asked', async () => {
    const notes = join(dir, 'NOTES.md');
    writeFileSync(notes, '# Notes\n\nSome thoughts, no decisions.\n');
    const r = await runCheck(ciArgs(notes));
    expect(r.exitCode).toBe(2);
    expect(json(r)).toMatchObject({ status: 'unknown', reason: 'decisions_file_empty' });
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('a bad file fails the check even when the diff is empty (it is read before the diff is looked at)', async () => {
    mockGetBaseDiff.mockResolvedValue('');
    const r = await runCheck(ciArgs(join(dir, 'nope.md')));
    expect(r.exitCode).toBe(2);
  });

  it('prints the problem for a person outside --ci, and still exits 2', async () => {
    const r = await runCheck(['--base', 'origin/main', '--decisions-file', join(dir, 'nope.md')]);
    expect(r.exitCode).toBe(2);
    expect(r.console).toContain('nope.md');
  });

  it.each([['--hook'], ['--advisory'], ['--resolve', 'd1:honored']])('refuses %s, which the file cannot serve, rather than ignoring it', async (...flag) => {
    const r = await runCheck([...ciArgs(), ...flag]);
    expect(r.exitCode).toBe(2);
    expect(mockProvider).not.toHaveBeenCalled();
  });
});
