import { describe, expect, it } from 'vitest';
import {
  agentAskLine,
  agentConnectedLine,
  firstQuestion,
  orderAgents,
  projectAgentsFromWritten,
  renderSecondRunCard,
} from '../lib/next-step.js';

/**
 * ALI-950. After the wizard, the next step happens in the agent, not at the prompt. Every
 * one of Claude Code, Codex, Cursor, Gemini CLI and Copilot CLI makes first value a chat
 * turn in the agent, never a setup verb - so the outro and the second-run card name the
 * agent and the question, and name no CLI verb.
 */

// A CLI verb is the tool's name followed by a subcommand. `align-cli/local.db` in a graph
// path and a bare `align` are not verbs, so the pattern requires whitespace after the name.
const CLI_VERB = /\balign\s+[a-z-]+/;
const CLI_VERBS = /\balign\s+[a-z-]+/g;

// The lines this ticket replaces, kept verbatim so the regex is proven to catch them.
const OLD_OUTRO_LAST_LINE = '  Ask it something real: align ask "why <a thing you decided>"';
const OLD_CARD = [
  '  Ask it something     align ask "why postgres"',
  '  See what is in it    align decisions list',
  '  Add another source   align import git',
  '  align --help for everything else',
].join('\n');

describe('the CLI-verb regex (positive control)', () => {
  it('catches the old outro line and the old card, so a clean pass below means something', () => {
    expect(OLD_OUTRO_LAST_LINE).toMatch(CLI_VERB);
    expect(OLD_CARD).toMatch(CLI_VERB);
    expect('  Local graph  /home/d/.config/align-cli/local.db').not.toMatch(CLI_VERB);
  });
});

describe('orderAgents', () => {
  it('puts the agent detected in this repo\'s project config first', () => {
    expect(orderAgents({ project: ['Claude Code'], global: ['Cursor', 'Claude Code'] }))
      .toEqual(['Claude Code', 'Cursor']);
  });

  it('keeps detection order when no project config names one', () => {
    expect(orderAgents({ project: [], global: ['Cursor', 'Zed'] })).toEqual(['Cursor', 'Zed']);
  });
});

describe('projectAgentsFromWritten', () => {
  it('names Claude Code when the project .mcp.json was written', () => {
    expect(projectAgentsFromWritten(['CLAUDE.md', '.mcp.json'])).toEqual(['Claude Code']);
  });

  it('names nobody when it was not', () => {
    expect(projectAgentsFromWritten(['CLAUDE.md'])).toEqual([]);
    expect(projectAgentsFromWritten([])).toEqual([]);
  });
});

describe('agentConnectedLine', () => {
  it('names one agent', () => {
    expect(agentConnectedLine(['Claude Code'])).toBe('Your agent is connected: Claude Code.');
  });

  it('names every agent, in order', () => {
    expect(agentConnectedLine(['Claude Code', 'Cursor'])).toBe('Your agent is connected: Claude Code, Cursor.');
  });

  it('says nothing when none is wired - a line claiming a connection that does not exist is worse than silence', () => {
    expect(agentConnectedLine([])).toBeUndefined();
  });
});

describe('firstQuestion', () => {
  it('is checkable against the repo when the wizard found a decision', () => {
    expect(firstQuestion('switch to postgres')).toBe('why did we switch to postgres?');
  });

  it('falls back to the one question an agent answers with a list tool, not a search', () => {
    expect(firstQuestion(undefined)).toBe('what decisions exist in this codebase?');
  });
});

describe('agentAskLine', () => {
  it('names the agent and the first found decision, in this repo', () => {
    const line = agentAskLine({ agents: ['Claude Code'], firstTitle: 'switch to postgres', inRepo: true, envName: 'local' });
    expect(line).toBe('Open Claude Code in this repo and ask: why did we switch to postgres?');
    expect(line).not.toMatch(CLI_VERB);
  });

  it('names the FIRST agent when several are wired, and drops "in this repo" on the card', () => {
    const line = agentAskLine({ agents: ['Cursor', 'Zed'], firstTitle: 'use trunk-based development', inRepo: false, envName: 'prod' });
    expect(line).toBe('Open Cursor and ask: why did we use trunk-based development?');
    expect(line).not.toMatch(CLI_VERB);
  });

  it('says no agent was detected and names `align mcp` exactly once, qualified with the env', () => {
    const line = agentAskLine({ agents: [], firstTitle: 'switch to postgres', inRepo: true, envName: 'local' });
    expect(line).toBe('No agent detected. Run align mcp --setup --env local, then ask it: why did we switch to postgres?');
    expect(line.match(/align mcp/g)).toHaveLength(1);
  });

  it('leaves the env off for prod, so the command is runnable as printed', () => {
    const line = agentAskLine({ agents: [], firstTitle: undefined, inRepo: false, envName: 'prod' });
    expect(line).toBe('No agent detected. Run align mcp --setup, then ask it: what decisions exist in this codebase?');
    expect(line).not.toContain('--env');
  });
});

describe('renderSecondRunCard', () => {
  const full = {
    graphLine: 'Local graph  /home/d/.config/align-cli/local.db',
    agents: ['Claude Code', 'Cursor'],
    hasDecisions: true,
    firstTitle: 'switch to postgres',
    envName: 'local' as const,
    value: { mode: 'local' as const, decisions: 12, conflictsCaught: 0, reuseRate: null },
  };

  it('shows the graph, the agents by name, the readout, and exactly one action - in the agent', () => {
    const card = renderSecondRunCard(full);
    expect(card).toContain('Local graph  /home/d/.config/align-cli/local.db');
    expect(card).toContain('Agents       Claude Code, Cursor');
    expect(card).toContain('Open Claude Code and ask: why did we switch to postgres?');
    expect(card.match(/Open .* and ask:/g)).toHaveLength(1);
    expect(card).not.toMatch(CLI_VERB);
    expect(card).not.toContain('--help');
  });

  it('cloud: labels the window the readout actually measures (this week), with the readout\'s own counts', () => {
    const card = renderSecondRunCard({
      ...full,
      graphLine: 'Signed in  prod',
      envName: 'prod',
      value: { mode: 'cloud', decisions: 142, conflictsCaught: 6, reuseRate: 0.72 },
    });
    expect(card).toContain('This week    6 conflicts caught, reuse rate 72%');
  });

  it('cloud: a null reuse rate is n/a, never a fabricated zero', () => {
    const card = renderSecondRunCard({
      ...full,
      envName: 'prod',
      value: { mode: 'cloud', decisions: 3, conflictsCaught: 0, reuseRate: null },
    });
    expect(card).toContain('This week    0 conflicts caught, reuse rate n/a');
  });

  it('local: has no window and no conflict counter offline (ALI-503), so it says what it knows', () => {
    // Nothing writes a conflict link offline, so a zero there reads as a broken counter and
    // is hidden; a real one appears the moment it exists, same rule as renderValueReadout.
    expect(renderSecondRunCard(full)).toContain('So far       12 decisions in your graph');
    expect(renderSecondRunCard(full)).not.toMatch(/conflicts caught/);
    const withConflict = renderSecondRunCard({ ...full, value: { ...full.value, conflictsCaught: 2 } });
    expect(withConflict).toContain('So far       12 decisions in your graph, 2 conflicts caught');
  });

  it('empty graph: the single action is `align connect`, the one verb the card may name', () => {
    const card = renderSecondRunCard({ ...full, hasDecisions: false, firstTitle: undefined, value: undefined });
    expect(card).toContain('align connect');
    expect(card).not.toContain('align import');
    expect(card.match(CLI_VERBS)).toHaveLength(1);
    expect(card).not.toMatch(/Open .* and ask:/);
    expect(card).toContain('Agents       Claude Code, Cursor');
  });

  it('no agent detected: says so and names `align mcp` once, and still hands over the question', () => {
    const card = renderSecondRunCard({ ...full, agents: [] });
    expect(card).toContain('Agents       none detected');
    expect(card).toContain('No agent detected. Run align mcp --setup --env local, then ask it: why did we switch to postgres?');
    expect(card.match(/align mcp/g)).toHaveLength(1);
  });

  it('several agents: the one detected in this repo leads', () => {
    const card = renderSecondRunCard({ ...full, agents: orderAgents({ project: ['Claude Code'], global: ['Cursor', 'Claude Code'] }) });
    expect(card).toContain('Open Claude Code and ask:');
  });

  it('a readout that could not be read leaves the line out rather than printing zeros', () => {
    const card = renderSecondRunCard({ ...full, value: undefined });
    expect(card).not.toMatch(/So far|This week/);
    expect(card).toContain('Open Claude Code and ask:');
  });
});
