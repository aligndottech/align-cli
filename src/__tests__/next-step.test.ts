import { describe, expect, it } from 'vitest';
import {
  agentAskLine,
  agentConnectedLine,
  agentTryLead,
  fileQuestion,
  firstQuestion,
  orderAgents,
  pickAskableTitle,
  projectAgentsFromWritten,
  renderSecondRunCard,
  renderStarterPrompts,
  reversalPrompt,
  starterPrompts,
} from '../lib/next-step.js';

/**
 * After the wizard, the next step happens in the agent, not at the prompt. Every
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

  // Preview QA (2026-09-11): a real imported title read as a policy statement, not
  // an action phrase, and got jammed into the template verbatim - "why did we All PRs must
  // pass typecheck, lint, test, and build before pushing?" is not a sentence. A title that
  // already reads as its own rule falls back instead of being forced into the template.
  it('falls back when the title is a policy statement, not an action phrase', () => {
    expect(firstQuestion('All PRs must pass typecheck, lint, test, and build before pushing'))
      .toBe('what decisions exist in this codebase?');
  });

  it('still uses a real title that starts with a quantifier-looking word but reads fine', () => {
    expect(firstQuestion('adopt trunk-based development')).toBe('why did we adopt trunk-based development?');
  });
});

describe('agentAskLine with a team destination', () => {
  it('names --env <destination> so the line runs as printed', () => {
    const line = agentAskLine({ agents: [], firstTitle: undefined, inRepo: true, envName: 'acme' as never });
    expect(line).toContain('align mcp --setup --env acme');
  });
  it('prod still prints the bare command', () => {
    const line = agentAskLine({ agents: [], firstTitle: undefined, inRepo: true, envName: 'prod' });
    expect(line).toContain('align mcp --setup,');
    expect(line).not.toContain('--env');
  });
  it('a name that is not shell-safe is refused, never printed', () => {
    expect(() => agentAskLine({ agents: [], firstTitle: undefined, inRepo: true, envName: 'a;rm -rf' as never })).toThrow(/not a safe/);
  });
});

describe('agentAskLine', () => {
  it('names the agent and the first found decision, in this repo', () => {
    const line = agentAskLine({ agents: ['Claude Code'], firstTitle: 'switch to postgres', inRepo: true, envName: 'local' });
    expect(line).toBe('Open Claude Code in this repo and ask: why did we switch to postgres?');
    expect(line).not.toMatch(CLI_VERB);
  });

  // Align supports every agent, and the project .mcp.json always reads as "Claude Code", so the
  // first wired agent is a guess. The agent the user chose wins; with no choice and several
  // wired, the line names none rather than the wrong one.
  it('several agents wired and none chosen: names no agent rather than guessing, and drops "in this repo" on the card', () => {
    const line = agentAskLine({ agents: ['Cursor', 'Zed'], firstTitle: 'use trunk-based development', inRepo: false, envName: 'prod' });
    expect(line).toBe('Open your coding agent and ask: why did we use trunk-based development?');
    expect(line).not.toMatch(CLI_VERB);
  });

  it('names the agent the user chose, even when another is wired first', () => {
    const line = agentAskLine({ agents: ['Claude Code', 'Codex'], chosen: 'Codex', firstTitle: undefined, inRepo: true, envName: 'local' });
    expect(line).toBe('Open Codex in this repo and ask: what decisions exist in this codebase?');
  });

  it('names a chosen agent that is not among the wired ones (align injects the graph when it opens it)', () => {
    const line = agentAskLine({ agents: ['Claude Code'], chosen: 'Grok Build', firstTitle: undefined, inRepo: false, envName: 'local' });
    expect(line).toBe('Open Grok Build and ask: what decisions exist in this codebase?');
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
    chosen: 'Claude Code',
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

  it('local: has no window and no conflict counter offline, so it says what it knows', () => {
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
    const card = renderSecondRunCard({ ...full, chosen: undefined, agents: [] });
    expect(card).toContain('Agents       none detected');
    expect(card).toContain('No agent detected. Run align mcp --setup --env local, then ask it: why did we switch to postgres?');
    expect(card.match(/align mcp/g)).toHaveLength(1);
  });

  it('several agents: the one the user chose leads, not the one the project config names', () => {
    const card = renderSecondRunCard({ ...full, chosen: 'Cursor', agents: orderAgents({ project: ['Claude Code'], global: ['Cursor', 'Claude Code'] }) });
    expect(card).toContain('Open Cursor and ask:');
  });

  it('several agents, none chosen: names no agent', () => {
    const card = renderSecondRunCard({ ...full, chosen: undefined, agents: ['Claude Code', 'Cursor'] });
    expect(card).toContain('Open your coding agent and ask:');
  });

  it('a readout that could not be read leaves the line out rather than printing zeros', () => {
    const card = renderSecondRunCard({ ...full, value: undefined });
    expect(card).not.toMatch(/So far|This week/);
    expect(card).toContain('Open Claude Code and ask:');
  });
});

/**
 * Show HN cold read: the suggested first question was a raw commit subject dropped
 * into "why did we ...?", giving "why did we fix: error throwing in reply (#6299)?". A
 * subject is only quoted when it reads as a base-form verb phrase once its conventional prefix
 * and PR number are stripped; anything else falls back to the generic question.
 */
describe('firstQuestion with real commit subjects', () => {
  const GENERIC = 'what decisions exist in this codebase?';
  const cases: Array<[string, string | undefined, string]> = [
    ['conventional prefix and PR number stripped', 'fix: close fastify instance (#6177)', 'why did we close fastify instance?'],
    ['fix: with a noun phrase cannot be turned into a verb phrase, so it falls back', 'fix: error throwing in reply (#6299)', GENERIC],
    ['scoped conventional prefix', 'feat(types): add missing error types (#6217)', 'why did we add missing error types?'],
    ['past-tense subject falls back', 'Improved links to MADR, added one template', GENERIC],
    ['a second colon (not a clean phrase) falls back', 'fix typo: closure -> clojure in the docs', GENERIC],
    ['capitalised base verb is lowercased', 'Update Recommendations.md (#6238)', 'why did we update Recommendations.md?'],
    ['PR number only, no prefix', 'delegate options processing to a dedicated function (#6333)', 'why did we delegate options processing to a dedicated function?'],
    ['longer than a sane length falls back', `add ${'very '.repeat(14)}long subject`, GENERIC],
    ['noun phrase falls back', 'Fluent-Schema docs', GENERIC],
    ['noun phrase opening with a verb-looking word', 'Support for Node 22', GENERIC],
    ['switch-looking noun phrase with a PR ref list', 'Default config values (#5, #6)', GENERIC],
    ['several PR refs are all stripped', 'fix: close the pool (#12) (#13)', 'why did we close the pool?'],
    ['a bare issue number falls back', 'Fix #123 crash', GENERIC],
    ['trailing period dropped', 'Keep it simple.', 'why did we keep it simple?'],
    ['a revert is not rewritten as the opposite', 'revert: Add x (#4)', GENERIC],
    ['semicolon falls back', 'Make the thing faster; also fix bar', GENERIC],
    ['empty string falls back', '', GENERIC],
    ['undefined falls back', undefined, GENERIC],
    ['only a prefix falls back', 'fix:', GENERIC],
  ];
  it.each(cases)('%s', (_name, title, expected) => {
    const q = firstQuestion(title);
    expect(q).toBe(expected);
    expect(q).not.toMatch(/why did we \w+:/);
    expect(q).not.toMatch(/\(#\d+\)/);
  });
});

describe('pickAskableTitle', () => {
  it('returns the first title that makes a grammatical question, raw', () => {
    expect(pickAskableTitle(['Improved links to MADR', 'fix: close fastify instance (#6177)', 'use postgres']))
      .toBe('fix: close fastify instance (#6177)');
  });
  it('returns undefined when none does, or the list is empty', () => {
    expect(pickAskableTitle(['Improved links', 'Fluent-Schema docs'])).toBeUndefined();
    expect(pickAskableTitle([])).toBeUndefined();
  });
});

/**
 * The outro used to hand over one question, about the past. A new user also needs to see
 * the two things Align is for: asking before touching a file, and the agent stopping when a
 * plan goes against a decision on record. Three prompts, built from the user's own graph and
 * repo, and printed (never sent into the agent).
 */
describe('reversalPrompt', () => {
  it('names a real decision and asks for the check before anything is written', () => {
    expect(reversalPrompt('feat(db): switch to postgres (#12)'))
      .toBe('Plan a change that reverses "switch to postgres". Check it with Align before writing anything.');
  });

  it('works for titles the "why did we" template cannot take, since it quotes rather than conjugates', () => {
    expect(reversalPrompt('All PRs must pass typecheck before pushing'))
      .toBe('Plan a change that reverses "All PRs must pass typecheck before pushing". Check it with Align before writing anything.');
  });

  it('swaps double quotes so the quoted title still reads as one quote', () => {
    expect(reversalPrompt('Use "strict" mode everywhere')).toContain('"Use \'strict\' mode everywhere"');
  });

  it.each([
    ['no title', undefined],
    ['empty', ''],
    ['only a prefix', 'fix:'],
    ['too long to quote', `keep ${'very '.repeat(20)}long`],
  ])('falls back to a prompt about the graph when there is %s', (_name, title) => {
    expect(reversalPrompt(title))
      .toBe('Pick a decision Align has on record here and plan a change that reverses it. Check it with Align before writing anything.');
  });
});

describe('fileQuestion', () => {
  it('asks what was decided about the file, before it is touched', () => {
    expect(fileQuestion('src/lib/config.ts')).toBe('what was decided about src/lib/config.ts?');
  });
});

describe('starterPrompts', () => {
  it('learn the past, check a file, then watch the agent push back - on the same decision', () => {
    expect(starterPrompts({ titles: ['Improved docs', 'feat: switch to postgres (#3)'], hotFile: 'src/db.ts' })).toEqual([
      'why did we switch to postgres?',
      'what was decided about src/db.ts?',
      'Plan a change that reverses "switch to postgres". Check it with Align before writing anything.',
    ]);
  });

  it('leaves the file prompt out when there is no file to name', () => {
    const prompts = starterPrompts({ titles: ['use postgres'] });
    expect(prompts).toHaveLength(2);
    expect(prompts.join('\n')).not.toMatch(/what was decided about/);
  });

  it('reverses a quotable title even when none is askable', () => {
    expect(starterPrompts({ titles: ['All PRs must pass CI'] })).toEqual([
      'what decisions exist in this codebase?',
      'Plan a change that reverses "All PRs must pass CI". Check it with Align before writing anything.',
    ]);
  });

  it('never reverses release housekeeping: the reversal names the decision with a reason', () => {
    const prompts = starterPrompts({ titles: ['Bumped v5.9.0', 'fix: clamp error statusCode between 400 and 599 with 500 fallback (#7089)'] });
    expect(prompts[1]).toBe('Plan a change that reverses "clamp error statusCode between 400 and 599 with 500 fallback". Check it with Align before writing anything.');
    expect(prompts.join('\n')).not.toMatch(/Bumped/);
  });

  it('with only housekeeping to name, falls back to the generic prompts instead of quoting it', () => {
    const prompts = starterPrompts({ titles: ['Bumped v5.9.0', 'v5.9.1'] });
    expect(prompts).toEqual([
      'what decisions exist in this codebase?',
      'Pick a decision Align has on record here and plan a change that reverses it. Check it with Align before writing anything.',
    ]);
  });

  it('does not quote a title the graph cut mid-word at 80 characters', () => {
    const cut = 'refactor(types)!: remove deprecated FastifyRequestContext and FastifyReplyContex'.slice(0, 80);
    expect(cut).toHaveLength(80);
    const prompts = starterPrompts({ titles: [cut, 'feat: switch to postgres (#3)'] });
    expect(prompts).toEqual([
      'why did we switch to postgres?',
      'Plan a change that reverses "switch to postgres". Check it with Align before writing anything.',
    ]);
  });

  it('names no CLI verb - the prompts are typed into the agent', () => {
    expect(starterPrompts({ titles: ['use postgres'], hotFile: 'a.ts' }).join('\n')).not.toMatch(CLI_VERB);
  });
});

describe('renderStarterPrompts', () => {
  it('numbers the prompts under the lead line', () => {
    expect(renderStarterPrompts('Opening Claude Code. Try these:', ['one?', 'two?'])).toBe(
      'Opening Claude Code. Try these:\n  1. one?\n  2. two?',
    );
  });
});

describe('agentTryLead', () => {
  it('names the one wired agent the prompts go to', () => {
    expect(agentTryLead({ agents: ['Codex'], inRepo: true, envName: 'local' })).toBe('Open Codex in this repo and try:');
  });
  it('names the chosen agent over the first wired one', () => {
    expect(agentTryLead({ agents: ['Claude Code', 'Qwen Code'], chosen: 'Qwen Code', inRepo: true, envName: 'local' })).toBe('Open Qwen Code in this repo and try:');
  });
  it('several wired, none chosen: names no agent rather than guessing', () => {
    expect(agentTryLead({ agents: ['Claude Code', 'Cursor'], inRepo: true, envName: 'local' })).toBe('Open your coding agent in this repo and try:');
  });
  it('with no agent, names align mcp once, qualified with the env', () => {
    expect(agentTryLead({ agents: [], inRepo: true, envName: 'local' })).toBe('No agent detected. Run align mcp --setup --env local, then try:');
  });
});
