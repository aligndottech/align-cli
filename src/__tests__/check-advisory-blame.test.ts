/**
 * Test list (ALI-1749), advisory hook level:
 *  1. Pre edit whose lines were written by a decision: that decision is listed FIRST under a label
 *     naming it as the writer of the lines, then the related list, without duplicates.
 *  2. Attributed decision and nothing related: still emitted (blame alone is an answer).
 *  3. Retrieval times out / fails: the attributed decision is still shown, beside the unverified note.
 *  4. No attribution (negative control): output is the old related-only text, no blame label.
 *  5. Post event never blames. Cloud client without the lookup never blames.
 *  6. Fail open: blame throws, or the lookup throws -> today's output.
 *  7. Dedup: an attributed id already surfaced is not repeated; shown ids are marked surfaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type * as BlameModule from '../lib/blame-attribution.js';
import { registerCheckCommand } from '../commands/check.js';

const mockCheckAlignment = vi.fn();
const mockBySourceRefs = vi.fn();
const mockFindLineWriters = vi.fn();
const mockRecently = vi.fn(() => new Set<string>());
const mockMark = vi.fn();
let clientHasLookup = true;

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ gatewayUrl: 'http://test', authToken: 'tok', tenantId: 'tid', mode: 'auth' })) })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn((e: string) => e ?? 'prod'), resolveImportEnv: vi.fn((e: string) => e ?? 'prod') }));
vi.mock('../lib/git.js', () => ({
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getStagedDiff: vi.fn(() => Promise.resolve('')),
  getHeadDiff: vi.fn(() => Promise.resolve('some diff')),
  getCurrentBranch: vi.fn(() => Promise.resolve('main')),
}));
const mockReadHookPayload = vi.fn(() => Promise.resolve<unknown>(null));
vi.mock('../lib/hook-payload.js', () => ({ readHookPayload: () => mockReadHookPayload() }));
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ checkAlignment: mockCheckAlignment, ...(clientHasLookup ? { decisionsBySourceRefs: mockBySourceRefs } : {}) })),
}));
vi.mock('../lib/advisory-dedup.js', () => ({ recentlySurfaced: () => mockRecently(), markSurfaced: (...a: unknown[]) => mockMark(...a) }));
vi.mock('../lib/blame-attribution.js', async (orig) => ({ ...(await orig<typeof BlameModule>()), findLineWriters: (...a: unknown[]) => mockFindLineWriters(...a) }));

const pre = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'lib/error-status.js', old_string: 'x >= 400', new_string: 'x >= 100' } };
const WRITER = { id: 'w1', title: 'fix: clamp error statusCode between 400 and 599 (#7089)', summary: 's' };
const RELATED = { id: 'r1', title: 'some related decision', summary: 's' };

async function run(): Promise<string> {
  const program = new Command();
  registerCheckCommand(program);
  let stdout = '';
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((c?: number) => { throw new Error(`exit(${c})`); });
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((stdout += String(c)), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { await program.parseAsync(['node', 'align', 'check', '--advisory', '--format', 'text']); } catch { /* exit */ } finally { exitSpy.mockRestore(); out.mockRestore(); err.mockRestore(); }
  return stdout;
}

beforeEach(() => {
  vi.clearAllMocks();
  clientHasLookup = true;
  mockReadHookPayload.mockResolvedValue(pre);
  mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [RELATED], conflicts: [] });
  mockFindLineWriters.mockResolvedValue({ commitShas: ['a'.repeat(40)], prUrls: [] });
  mockBySourceRefs.mockReturnValue([WRITER]);
  mockRecently.mockReturnValue(new Set());
});

describe('advisory blame attribution', () => {
  it('lists the decision that wrote the lines first, labelled, then the related list without duplicates', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [RELATED, { ...WRITER }], conflicts: [] });
    const out = await run();
    expect(out).toContain('written by a prior decision');
    expect(out.indexOf(WRITER.title)).toBeGreaterThan(-1);
    expect(out.indexOf(WRITER.title)).toBeLessThan(out.indexOf(RELATED.title));
    expect(out.split(WRITER.title).length - 1).toBe(1);
    expect(mockBySourceRefs).toHaveBeenCalledWith(['a'.repeat(40)], []);
    expect(mockMark).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['w1', 'r1']));
  });

  it('still speaks when blame found a writer and retrieval found nothing', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [], conflicts: [] });
    const out = await run();
    expect(out).toContain(WRITER.title);
  });

  it('shows the writer beside the unverified note when retrieval fails', async () => {
    mockCheckAlignment.mockRejectedValue(new Error('down'));
    const out = await run();
    expect(out).toContain(WRITER.title);
    expect(out).toContain('could not check');
  });

  it('negative control: no attributed decision means the old related-only text, with no blame label', async () => {
    mockBySourceRefs.mockReturnValue([]);
    const out = await run();
    expect(out).toContain(RELATED.title);
    expect(out).not.toContain('written by a prior decision');
  });

  it('does not blame on a post event, nor when the client has no lookup (cloud)', async () => {
    mockReadHookPayload.mockResolvedValue({ ...pre, hook_event_name: 'PostToolUse' });
    await run();
    expect(mockFindLineWriters).not.toHaveBeenCalled();
    mockReadHookPayload.mockResolvedValue(pre);
    clientHasLookup = false;
    const out = await run();
    expect(mockFindLineWriters).not.toHaveBeenCalled();
    expect(out).toContain(RELATED.title);
  });

  it('fails open to today\'s output when blame or the lookup throws', async () => {
    mockFindLineWriters.mockRejectedValueOnce(new Error('boom'));
    expect(await run()).toContain(RELATED.title);
    mockBySourceRefs.mockImplementationOnce(() => { throw new Error('db'); });
    const out = await run();
    expect(out).toContain(RELATED.title);
    expect(out).not.toContain('written by a prior decision');
  });

  it('does not repeat an attributed decision the sibling hook already surfaced', async () => {
    mockRecently.mockReturnValue(new Set(['w1']));
    const out = await run();
    expect(out).not.toContain(WRITER.title);
    expect(out).toContain(RELATED.title);
  });
});

describe('every related hit is also a writer', () => {
  it('is still well formed: writers block, no empty related list, and the closing instruction', async () => {
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [WRITER], conflicts: [] });
    const out = (await run()).trimEnd();
    expect(out.startsWith('Align decision graph: the lines this edit changes were written by a prior decision')).toBe(true);
    expect(out).not.toContain('relate to this change');
    expect(out).not.toContain('NOT been adjudicated');
    expect(out.split('\n').at(-1)).toBe('Tell the user in one line which of these you checked against and whether this change agrees with it.');
  });
});

describe('only decisions worth honouring count as writers', () => {
  const DOCS = { id: 'd1', title: 'docs(readme): move table of contents (#4722)', summary: 's' };

  it('a docs-type writer is not a writer, but stays in the related list when retrieval finds it', async () => {
    mockBySourceRefs.mockReturnValue([DOCS]);
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [DOCS], conflicts: [] });
    const out = await run();
    expect(out).not.toContain('written by a prior decision');
    expect(out).toContain(DOCS.title);
  });

  it('a refactor-type writer is not a writer either (it rewrote the lines without deciding what they do)', async () => {
    const REFACTOR = { id: 'f1', title: 'refactor(core): split error handling', summary: 's' };
    mockBySourceRefs.mockReturnValue([REFACTOR]);
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [REFACTOR], conflicts: [] });
    const out = await run();
    expect(out).not.toContain('written by a prior decision');
    expect(out).toContain(REFACTOR.title);
  });

  it('a docs-type writer alone, with nothing related, prints nothing', async () => {
    mockBySourceRefs.mockReturnValue([DOCS]);
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [], conflicts: [] });
    expect(await run()).toBe('');
  });

  it('a fix-type writer on the same edit still shows beside an excluded docs writer', async () => {
    mockBySourceRefs.mockReturnValue([DOCS, WRITER]);
    mockCheckAlignment.mockResolvedValue({ status: 'retrieved', relevant_decisions: [], conflicts: [] });
    const out = await run();
    expect(out).toContain('written by a prior decision');
    expect(out).toContain(WRITER.title);
    expect(out).not.toContain(DOCS.title);
  });
});
