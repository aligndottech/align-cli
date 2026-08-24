/**
 * ALI-602: `align context sync` - the command that wires the ALI-196 renderer.
 *
 * The renderer/writer (decisions-context.ts) is already pinned by its own two
 * suites. These tests pin the COMMAND: what it fetches, where it writes, what
 * it says, and that a fetch failure cannot masquerade as a sync.
 *
 * Test List:
 * 1. writes .align/decisions.md containing the fetched titles
 * 2. appends the CLAUDE.md import line exactly once across two runs
 * 3. re-run with an unchanged graph is byte-identical on both files
 * 4. no CLAUDE.md: none is invented; the import line is printed for manual add
 * 5. fetch failure: exits non-zero and does NOT write the context file
 * 6. empty graph: file written with the explicit "no decisions" body, exit 0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- Hoisted mock state ----------------------------------------------------
const { mockListDecisions } = vi.hoisted(() => ({
  mockListDecisions: vi.fn(),
}));

vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ listDecisions: mockListDecisions })),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ mode: 'local-embedded', gatewayUrl: 'http://localhost:0' })),
  })),
}));

vi.mock('../lib/resolve-env.js', () => ({
  resolveEnv: vi.fn(() => 'local'),
}));

import { registerContextCommand } from '../commands/context.js';

const DECISIONS = [
  {
    id: '1',
    title: 'Use Postgres 16 for new services',
    summary: '',
    platform: 'github',
    status: 'active',
    source_url: 'https://github.com/acme/api/pull/1441',
  },
  {
    id: '2',
    title: 'Synchronous gRPC for service calls',
    summary: '',
    platform: 'slack',
    status: 'active',
  },
];

function makeProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerContextCommand(p);
  return p;
}

const run = (...extra: string[]) =>
  makeProgram().parseAsync(['node', 'align', 'context', 'sync', ...extra]);

let repo: string;
let prevCwd: string;
let logs: string[];

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ali602-'));
  prevCwd = process.cwd();
  process.chdir(repo);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  mockListDecisions.mockReset().mockResolvedValue(DECISIONS);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(repo, rel));

describe('align context sync', () => {
  it('writes .align/decisions.md containing the fetched titles', async () => {
    await run();
    expect(exists('.align/decisions.md')).toBe(true);
    const file = read('.align/decisions.md');
    expect(file).toContain('Use Postgres 16 for new services');
    expect(file).toContain('Synchronous gRPC for service calls');
    // The cite is derived from source_url, so the agent can quote a decision.
    // citationFor renders the short form (repo#number), the house convention.
    expect(file).toContain('(api#1441)');
  });

  it('appends the CLAUDE.md import line exactly once across two runs', async () => {
    const HAND_WRITTEN = '# My project\n\nHand-tuned guidance.\n';
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), HAND_WRITTEN);

    await run();
    await run();

    const claude = read('CLAUDE.md');
    // Their bytes survive, and the import appears once, not once per run.
    expect(claude).toContain('Hand-tuned guidance.');
    expect(claude.match(/@\.align\/decisions\.md/g)).toHaveLength(1);
  });

  it('re-run with an unchanged graph is byte-identical on both files', async () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# My project\n');
    await run();
    const first = { ctx: read('.align/decisions.md'), claude: read('CLAUDE.md') };
    await run();
    expect(read('.align/decisions.md')).toBe(first.ctx);
    expect(read('CLAUDE.md')).toBe(first.claude);
  });

  it('invents no CLAUDE.md; prints the import line for manual add', async () => {
    await run();
    expect(exists('CLAUDE.md')).toBe(false);
    // The user must be told the one line to add - silence here strands the file.
    expect(logs.join('\n')).toContain('@.align/decisions.md');
  });

  it('exits non-zero on fetch failure and does not write the context file', async () => {
    mockListDecisions.mockRejectedValue(new Error('gateway unreachable'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(run()).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    // A failed fetch must not leave a plausible-looking empty file behind:
    // "no decisions" and "could not fetch" are different claims (ALI-414).
    expect(exists('.align/decisions.md')).toBe(false);
  });

  it('fetches active decisions only, within the limit', async () => {
    await run();
    // 'active' is load-bearing: the file states what currently GOVERNS, and a
    // fetch without the filter would render superseded decisions as if live.
    expect(mockListDecisions).toHaveBeenCalledWith({ limit: 200, status: 'active' });
  });

  it('a malformed --limit falls back to the default instead of becoming NaN', async () => {
    await run('--limit', 'abc');
    // NaN would slice the local graph to [] and write a plausible EMPTY file -
    // the silent failure this command is built to refuse (Copilot, #120).
    expect(mockListDecisions).toHaveBeenCalledWith({ limit: 200, status: 'active' });
  });

  it('empty graph: writes the explicit no-decisions body and exits 0', async () => {
    mockListDecisions.mockResolvedValue([]);
    await run();
    expect(read('.align/decisions.md')).toContain('No decisions have been captured');
  });
});
