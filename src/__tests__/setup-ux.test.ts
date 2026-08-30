import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));

import { cliTokenDecision, detectCliToken, pickerMaxItems } from '../lib/setup-ux.js';

// David (outside tester, 2026-08-30) hit a corrupted connector picker: options
// duplicated on screen ("Notion" three times) and scrolling misbehaved. Cause is
// @clack/prompts redrawing a list taller than the terminal with no `maxItems`, under
// a screenful of git-import output. pickerMaxItems bounds the list to the viewport.
describe('pickerMaxItems', () => {
  it('shows every option when the terminal is comfortably tall', () => {
    expect(pickerMaxItems(40, 7)).toBe(7);
  });

  it('PAGINATES rather than overflowing when the terminal is short', () => {
    const n = pickerMaxItems(10, 7);
    expect(n).toBeLessThan(7);   // the whole point: must not render all 7
    expect(n).toBeGreaterThan(0);
  });

  it('keeps a usable floor even on an absurdly short terminal', () => {
    // A 1-row terminal must not yield 0 or a negative maxItems: clack would either
    // render nothing or throw. Assert the floor explicitly.
    expect(pickerMaxItems(1, 7)).toBeGreaterThanOrEqual(3);
  });

  it('falls back to a safe default when the terminal size is unknown', () => {
    // process.stdout.rows is undefined when stdout is not a TTY (CI, pipes).
    const n = pickerMaxItems(undefined, 7);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBe(7);
  });

  it('never returns more than the number of options', () => {
    expect(pickerMaxItems(200, 7)).toBe(7);
  });
});

// David has `gh` authenticated already, and setup sent him to github.com to mint a PAT
// by hand. His words, quoted verbatim including the typo, because a paraphrase would
// stop being evidence: "you may also want to intergrate [sic] with gh-cli / as I have
// that setup".
describe('detectCliToken', () => {
  beforeEach(() => { mockExeca.mockReset(); });

  it('returns the token when the CLI is authenticated', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'gho_abc123' });
    await expect(detectCliToken('gh', ['auth', 'token'])).resolves.toBe('gho_abc123');
  });

  it('trims the trailing newline the CLI prints', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'gho_abc123\n' });
    await expect(detectCliToken('gh', ['auth', 'token'])).resolves.toBe('gho_abc123');
  });

  it('returns null when the binary is not installed', async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    mockExeca.mockRejectedValue(err);
    await expect(detectCliToken('gh', ['auth', 'token'])).resolves.toBeNull();
  });

  it('returns null when the CLI exits non-zero (not logged in)', async () => {
    mockExeca.mockRejectedValue(Object.assign(new Error('exit 1'), { exitCode: 1 }));
    await expect(detectCliToken('gh', ['auth', 'token'])).resolves.toBeNull();
  });

  it('returns null when the CLI succeeds but prints nothing usable', async () => {
    // Empty is not a token. Returning '' here would paste a blank credential and the
    // failure would surface much later, as an auth error from the fetcher.
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '   \n' });
    await expect(detectCliToken('gh', ['auth', 'token'])).resolves.toBeNull();
  });

  it('actually invokes the binary and args it was given', async () => {
    // Positive control: proves the subject RAN, rather than the assertions being
    // satisfied by a rejected promise somewhere. See tdd.md.
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'tok' });
    await detectCliToken('glab', ['auth', 'status']);
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca.mock.calls[0]?.[0]).toBe('glab');
    expect(mockExeca.mock.calls[0]?.[1]).toEqual(['auth', 'status']);
  });
});

// Copilot on #183: `--approve` is documented as "Skip confirmation prompts (for scripted
// use)", and the gh-token reuse added a p.confirm() to that path. This repo has already
// been bitten once by an unguarded prompt under --approve (setup.ts still carries the
// comment about two agents hanging it), so the decision is a function rather than an
// `if` buried in an async prompt chain.
describe('cliTokenDecision', () => {
  it('skips when no CLI token was found', () => {
    expect(cliTokenDecision({ token: null, approve: false })).toBe('skip');
    expect(cliTokenDecision({ token: null, approve: true })).toBe('skip');
  });

  it('asks when a token was found in an ordinary interactive run', () => {
    expect(cliTokenDecision({ token: 'gho_x', approve: false })).toBe('ask');
  });

  it('USES the token without asking under --approve', () => {
    // The flag means "skip confirmation prompts", so the affirmative is the default.
    // Skipping the connector instead would silently drop a source the user could have
    // had, which is a worse reading of the same flag.
    expect(cliTokenDecision({ token: 'gho_x', approve: true })).toBe('use');
  });

  it('treats an empty token as no token, whatever the flag says', () => {
    expect(cliTokenDecision({ token: '', approve: true })).toBe('skip');
  });
});
