import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn() })),
}));

const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('local'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));

const getEnvironment = vi.hoisted(() => vi.fn().mockReturnValue({ mode: 'local-embedded' }));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment })) }));

const listDecisions = vi.hoisted(() => vi.fn());
const getDecision = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ listDecisions, getDecision })),
}));
// resolveAppUrl lives in env-resolver, not gateway-client. Mocking the wrong module made the
// cloud case throw into the command's catch and call process.exit(1) - which surfaced as
// "process.exit unexpectedly called" rather than anything naming the real cause.
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));

const output: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });

import { registerDecisionsCommand } from '../commands/decisions/index.js';

async function run(args: string[]): Promise<string> {
  output.length = 0;
  const program = new Command();
  program.exitOverride();
  registerDecisionsCommand(program);
  await program.parseAsync(['node', 'align', 'decisions', ...args]);
  return output.join('\n');
}

/**
 * ALI-772. These assert what the command RENDERS. An earlier version of this suite read
 * src/commands/decisions/index.ts and matched regexes against it, which is a claim about the
 * shape of the source rather than about behaviour: a reformat breaks it, and a genuine
 * regression that kept the same text would not. A review bot pushed back on that and was
 * right.
 */
describe('decisions list rendering', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    listDecisions.mockReset();
    getDecision.mockReset();
  });

  /**
   * The header printed `opts.env` - the FLAG - so a bare `align decisions list` rendered
   * "Decisions (undefined)". It stayed invisible while the bare command 401'd before ever
   * reaching the header; removing that 401 is what surfaced it.
   */
  it('names the env it resolved to, not the flag that was not passed', async () => {
    listDecisions.mockResolvedValue([{ id: 'a1', title: 'Chose Postgres', platform: 'git', status: 'active' }]);
    const out = await run(['list']);
    expect(out).toContain('Decisions (local)');
    expect(out).not.toContain('undefined');
  });

  it('still names an explicitly requested env', async () => {
    resolveEnv.mockReturnValue('prod');
    listDecisions.mockResolvedValue([{ id: 'a1', title: 'Chose Postgres', platform: 'git', status: 'active' }]);
    expect(await run(['list', '--env', 'prod'])).toContain('Decisions (prod)');
  });

  // ALI-829 R27a
  it('shows a DECIDED column with the source date when the row carries one', async () => {
    listDecisions.mockResolvedValue([
      { id: 'a1', title: 'Chose Postgres', platform: 'git', status: 'active', decided_at: '2026-03-01T09:00:00.000Z' },
    ]);
    const out = await run(['list']);
    expect(out).toContain('DECIDED');
    expect(out).toContain('1 Mar 2026');
  });

  // ALI-829 R27b
  it('leaves the DECIDED cell empty for a row with no source date - never "Invalid Date", never the ingest minute', async () => {
    listDecisions.mockResolvedValue([
      { id: 'a1', title: 'Chose Postgres', platform: 'git', status: 'active', created_at: '2026-05-30T09:00:00.000Z' },
      { id: 'a2', title: 'Chose Redis', platform: 'git', status: 'active', decided_at: '2026-03-01T09:00:00.000Z' },
    ]);
    const out = await run(['list']);
    expect(out).toContain('1 Mar 2026');          // the dated row, the positive control
    expect(out).not.toContain('Invalid Date');
    expect(out).not.toContain('30 May 2026');      // created_at is not a decision date
  });
});

describe('decisions show rendering', () => {
  beforeEach(() => {
    resolveEnv.mockReturnValue('local');
    getDecision.mockReset().mockResolvedValue({
      id: 'a1', title: 'Chose Postgres', summary: 'concurrent writers', platform: 'git',
    });
  });

  /**
   * A local graph has no web UI, so this line pointed a local-only user at a dev server that
   * is not running on their machine and never will be. A dead link is worse than no link.
   */
  it('omits the View link for the local graph', async () => {
    const out = await run(['show', 'a1']);
    expect(out).toContain('Chose Postgres');   // positive control: it rendered the decision
    expect(out).not.toContain('View:');
    expect(out).not.toContain('localhost:5173');
  });

  it('keeps the View link for a cloud graph, where it goes somewhere', async () => {
    resolveEnv.mockReturnValue('prod');
    const out = await run(['show', 'a1']);
    expect(out).toContain('View:');
  });
});
