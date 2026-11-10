import { describe, expect, it, vi } from 'vitest';
import { askAgentAndWrites, NO_WRITES } from '../lib/setup/agent-and-writes.js';
import type { PlannedWrite } from '../lib/write-confirm.js';

/**
 * With two or more coding agents installed, "which agent?" and "write these files?" were two
 * screens. They are one: the file list, then one question whose answers are the agents and
 * "Do not write anything".
 *
 * Test List:
 * - Picking an agent: the files are confirmed and that agent is returned (two examples).
 * - "Do not write anything": nothing confirmed, no agent.
 * - A cancel is a cancel, never a choice.
 * - No files to write: the question only asks for the agent, with no "do not write" answer.
 * - The file list is printed before the question.
 */

const FILES: PlannedWrite[] = [{ file: '/repo/.mcp.json', display: '.mcp.json', action: 'create' }];
const AGENTS = [{ name: 'claude-code', label: 'Claude Code' }, { name: 'codex', label: 'Codex' }];

function setup(answer: string | undefined, files = FILES) {
  const printed: string[] = [];
  const select = vi.fn(async (_m: string, _o: Array<{ value: string; label: string }>) => answer);
  const run = () => askAgentAndWrites({ files, agents: AGENTS, print: (t) => printed.push(t), select });
  return { run, select, printed };
}

describe('one screen for the agent and the files', () => {
  it('picking Claude Code confirms the files and returns it', async () => {
    const s = setup('claude-code');
    expect(await s.run()).toEqual({ agent: 'claude-code', confirmed: true });
    const [message, options] = s.select.mock.calls[0]!;
    expect(message).toBe('Write these files, then open which agent?');
    expect(options).toEqual([
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' },
      { value: NO_WRITES, label: 'Do not write anything' },
    ]);
  });

  it('picking Codex returns Codex', async () => {
    expect(await setup('codex').run()).toEqual({ agent: 'codex', confirmed: true });
  });

  it('"Do not write anything" confirms nothing and picks no agent', async () => {
    expect(await setup(NO_WRITES).run()).toEqual({ agent: null, confirmed: false });
  });

  it('a cancel is a cancel', async () => {
    expect(await setup(undefined).run()).toBe('cancelled');
  });

  it('with no files to write it only asks for the agent', async () => {
    const s = setup('codex', []);
    expect(await s.run()).toEqual({ agent: 'codex', confirmed: true });
    const [message, options] = s.select.mock.calls[0]!;
    expect(message).toBe('Which agent should Align open?');
    expect(options.map((o) => o.value)).toEqual(['claude-code', 'codex']);
    expect(s.printed).toEqual([]);
  });

  it('prints the file list before asking', async () => {
    const order: string[] = [];
    const select = vi.fn(async () => { order.push('ask'); return 'codex'; });
    await askAgentAndWrites({ files: FILES, agents: AGENTS, print: (t) => { order.push('print'); expect(t).toContain('.mcp.json'); }, select });
    expect(order).toEqual(['print', 'ask']);
  });
});
