import type { EnvName } from './config.js';
import { envFlag } from './destination-name.js';

/**
 * After the wizard, the next step is in the agent.
 *
 * Every one of Claude Code, Codex, Cursor, Gemini CLI and Copilot CLI makes first value a
 * chat turn in the agent, never a setup verb. Both outros used to end on `align ask ...`
 * and the second-run card suggested three CLI verbs and `align --help` - every next step
 * something to type at the prompt, when the product's whole value is a question asked in
 * the agent that already has the graph wired. So the outro and the card name the agent and
 * the question, and name no CLI verb.
 *
 * Pure string builders, no I/O and no chalk, so the wording is unit-testable and there is
 * ONE writer of it for both surfaces (the outro in setup.ts, the card in default-action.ts).
 */

export interface WiredAgents {
  /** Agents wired through this repo's project config (.mcp.json). */
  project: string[];
  /** Agents wired through their global config, in detection order. */
  global: string[];
}

/**
 * The agent detected in this repo's project config leads: it is the one the user is most
 * likely sitting in, since the wizard ran from this repo. Then the rest, deduplicated - Claude
 * Code reads both its global ~/.claude.json and the project .mcp.json, and is one agent.
 */
export function orderAgents(w: WiredAgents): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...w.project, ...w.global]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Which agents setupAgentAlignment's write reached, from the file list it returns. Only
 * `.mcp.json` wires an agent's MCP client (the rest are hooks and nudges); Claude Code is the
 * agent that reads it as a project config. pi reads it too, through pi-mcp-adapter, but only
 * when installed, and the outro must not name an agent that may not exist on the machine.
 */
export function projectAgentsFromWritten(written: string[]): string[] {
  return written.includes('.mcp.json') ? ['Claude Code'] : [];
}

/** Prints only when something was actually wired: a connection claim with nothing behind it is worse than silence. */
export function agentConnectedLine(agents: string[]): string | undefined {
  if (agents.length === 0) return undefined;
  return `Your agent is connected: ${agents.join(', ')}.`;
}

/**
 * A decision title is only quoted into "why did we X?" when X is a base-form verb
 * phrase, so the result is a sentence. A raw commit subject is not one: "fix: error throwing in
 * reply (#6299)" has a conventional prefix and a PR number, and "Improved links to MADR" is past
 * tense. The prefix and PR number are stripped, and the rest must open with a verb from the list
 * below; anything else (noun phrases, past tense, a leftover colon, policy statements such as
 * "All PRs must ...", over twelve words) falls back to the generic question. The list is
 * deliberately short and quoting a subject is optional, so a miss costs only a generic question.
 */
const CONVENTIONAL_PREFIX = /^(?:feat|fix|refactor|perf|types?|deps?|security)(?:\([^)]*\))?!?:\s*/i;
const PR_REFERENCE = /\s*\(#\d+[^)]*\)/g;
const MAX_TOPIC_WORDS = 12;
const BASE_VERBS = new Set([
  'add', 'adopt', 'allow', 'avoid', 'change', 'close', 'consolidate', 'delegate', 'deprecate',
  'disable', 'drop', 'enable', 'enforce', 'ensure', 'extract', 'fix', 'handle', 'ignore', 'implement',
  'introduce', 'keep', 'make', 'migrate', 'move', 'prefer', 'prevent', 'put', 'refactor',
  'reject', 'remove', 'rename', 'replace', 'require', 'restrict', 'reuse', 'send',
  'simplify', 'skip', 'split', 'stop', 'switch', 'throw', 'treat', 'update',
  'upgrade', 'use', 'validate', 'warn',
]);

/** The quotable phrase inside a commit subject or decision title, or undefined. */
function askablePhrase(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const phrase = title.trim().replace(CONVENTIONAL_PREFIX, '').replace(PR_REFERENCE, '').trim().replace(/\.$/, '');
  if (phrase === '' || /[:?;#]/.test(phrase)) return undefined;
  const words = phrase.split(/\s+/);
  if (words.length > MAX_TOPIC_WORDS) return undefined;
  const verb = words[0]!.toLowerCase();
  if (!BASE_VERBS.has(verb)) return undefined;
  return verb + phrase.slice(words[0]!.length);
}

/** The first title in the list that makes a grammatical question, as it was given. */
export function pickAskableTitle(titles: readonly string[]): string | undefined {
  return titles.find((t) => askablePhrase(t) !== undefined);
}

/**
 * The question to hand the agent. Against a REAL decision the wizard found when there is one,
 * because "why did we X" is checkable against the repo the user is sitting in. The fallback
 * is ABOUT the graph rather than in it, which is a bad thing to type into `align ask` (on-device search matches nothing) and a fine thing to ask an agent, which answers it with a
 * list tool rather than a similarity search.
 */
export function firstQuestion(firstTitle: string | undefined): string {
  const phrase = askablePhrase(firstTitle);
  return phrase ? `why did we ${phrase}?` : 'what decisions exist in this codebase?';
}

/** Runnable AS PRINTED: bare `align mcp --setup` wires the cloud default, which is not a local user's graph. */
function mcpSetupCommand(envName: EnvName): string {
  return `align mcp --setup${envFlag(envName)}`;
}

/**
 * The outro's last line when the person declined the config writes: no agent has align's MCP
 * entry or hook, so it must not say "open X and ask". Names both ways to connect later: a
 * re-run writes the project files and every detected agent; `align mcp --setup` writes only
 * the agents' own config.
 */
export function agentNotConnectedLine(envName: EnvName): string {
  return `Your agent is not connected, because you chose not to write its config. Run align again to connect it, or ${mcpSetupCommand(envName)} for the agents on this machine.`;
}

/**
 * The one next action, and it happens in the agent. `inRepo` is the outro (the wizard just
 * ran here, and the project config only applies here); the card drops it.
 *
 * With no agent detected the line says so and names `align mcp` ONCE - the only CLI verb it
 * may carry, and the ask is still what follows it.
 */
export function agentAskLine(opts: {
  agents: string[];
  firstTitle: string | undefined;
  inRepo: boolean;
  envName: EnvName;
}): string {
  const question = firstQuestion(opts.firstTitle);
  const first = opts.agents[0];
  if (!first) {
    return `No agent detected. Run ${mcpSetupCommand(opts.envName)}, then ask it: ${question}`;
  }
  return `Open ${first}${opts.inRepo ? ' in this repo' : ''} and ask: ${question}`;
}

/**
 * The readout's numbers the card shows. `mode` decides the label: cloud reads a
 * windowed impact and reuse rate off the gateway (the caller says how many days), local has
 * no window at all - its link counts are all-time - and nothing writes a conflict link
 * offline, so a zero there is hidden rather than printed as a broken counter (the
 * same rule renderValueReadout applies).
 *
 * The ticket asked for "N conflicts caught, M answers served". The readout has no
 * answers-served counter, so this prints the numbers it DOES have and labels them as what
 * they are, rather than inventing one.
 */
export interface CardValue {
  mode: 'cloud' | 'local';
  decisions: number;
  conflictsCaught: number;
  reuseRate: number | null;
}

export interface SecondRunCard {
  /** Already composed by the caller: `Local graph  <path>` or `Signed in    <env>`. */
  graphLine: string;
  /** Wired agents, already ordered (orderAgents). */
  agents: string[];
  hasDecisions: boolean;
  firstTitle: string | undefined;
  envName: EnvName;
  /** Absent when the readout could not be read: the line is left out, never zeros. */
  value: CardValue | undefined;
}

/** Labels are padded to one column so the card reads as a table. */
const LABEL_WIDTH = 13;
export function cardLabel(label: string): string {
  return label.padEnd(LABEL_WIDTH);
}

function valueLine(v: CardValue): string {
  if (v.mode === 'cloud') {
    const reuse = v.reuseRate === null ? 'n/a' : `${Math.round(v.reuseRate * 100)}%`;
    return `${cardLabel('This week')}${v.conflictsCaught} conflicts caught, reuse rate ${reuse}`;
  }
  const conflicts = v.conflictsCaught > 0 ? `, ${v.conflictsCaught} conflicts caught` : '';
  return `${cardLabel('So far')}${v.decisions} decisions in your graph${conflicts}`;
}

/**
 * The card bare `align` prints once set up. Graph, agents by name, the readout, and exactly
 * ONE next action. No CLI verb, with one exception: an empty graph's action is
 * `align connect`, because nothing in the agent can fill a graph yet.
 */
export function renderSecondRunCard(card: SecondRunCard): string {
  const lines = [
    `  ${card.graphLine}`,
    `  ${cardLabel('Agents')}${card.agents.length ? card.agents.join(', ') : 'none detected'}`,
  ];
  if (card.value) lines.push(`  ${valueLine(card.value)}`);
  lines.push('');
  if (!card.hasDecisions) {
    // The one verb, and it is the picker - git needs no token and is the first row.
    lines.push('  Your graph is empty. Fill it:');
    lines.push('    align connect');
  } else {
    lines.push(`  ${agentAskLine({ agents: card.agents, firstTitle: card.firstTitle, inRepo: false, envName: card.envName })}`);
  }
  return lines.join('\n');
}
