import { isReadOnlyCommand } from './read-only-command.js';
import type { BrokerVerdict, GateDecision, GateOutcome, HumanAnswer, ToolAsk } from './types.js';

/**
 * Who has to approve a tool call, for both engines. Edits go through the edit gate and reach a
 * person only when the gate asks; commands always reach a person unless they allowed that command
 * for this session; reads never do. A denial carries a message written for the MODEL, because the
 * engine hands it back as the tool result - that is how "stop" turns into the agent changing course.
 */

export type HumanQuestion =
  | { kind: 'gate'; outcome: Extract<GateOutcome, { kind: 'ask' }>; ask: ToolAsk }
  | { kind: 'command'; command: string; ask: ToolAsk };

export interface BrokerDeps {
  gate: (ask: ToolAsk) => Promise<GateOutcome>;
  askHuman: (q: HumanQuestion) => Promise<HumanAnswer>;
  onGate: (outcome: GateOutcome, ask: ToolAsk) => void;
}

/** Only an explicit yes allows. An answer this code does not know (a future key, a cancel) is a stop. */
const allows = (a: HumanAnswer): boolean => a === 'allow' || a === 'allow-session';

function decisionLine(d: GateDecision): string {
  return [`- ${d.title}`, d.why ? ` - ${d.why}` : '', d.url ? ` (${d.url})` : ''].join('');
}

function stopMessage(outcome: Extract<GateOutcome, { kind: 'ask' }>): string {
  const lead = {
    conflict: 'Align: the person stopped this edit. It conflicts with a recorded decision:',
    'rewrites-decided-lines': 'Align: the person stopped this edit. It changes lines written by a recorded decision:',
    unchecked: 'Align: the person stopped this edit. Align could not read it to check it against the decisions.',
  }[outcome.reason];
  return [lead, ...outcome.cards.map(decisionLine), 'Do not retry this edit. Ask the person how they want to proceed.'].join('\n');
}

export function createBroker(deps: BrokerDeps): (ask: ToolAsk) => Promise<BrokerVerdict> {
  // "Yes for this session" remembers the EXACT command, or the tool by name. A prefix match let
  // an allowed `git status` approve `git status; rm -rf ~` (security review).
  const sessionAllowed = new Set<string>();

  return async (ask) => {
    if (ask.kind === 'read') return { allow: true };
    if (ask.kind === 'edit') {
      const outcome = await deps.gate(ask);
      deps.onGate(outcome, ask);
      if (outcome.kind === 'allow') return { allow: true };
      const answer = await deps.askHuman({ kind: 'gate', outcome, ask });
      return allows(answer) ? { allow: true } : { allow: false, message: stopMessage(outcome) };
    }
    // A command that can only read passes; anything chained, redirected or unknown still asks.
    if (ask.kind === 'command' && isReadOnlyCommand(ask.command ?? '')) return { allow: true };
    // A command, or a tool this code does not know (WebFetch, an MCP tool, a subagent): a person decides.
    // An unknown tool is approved for its input, not its name: a yes to one URL is not a yes to all.
    // The question shows the WHOLE input: approval covers all of it, so none may hide past a cut.
    const label = ask.kind === 'command' ? (ask.command ?? '') : [ask.tool, ask.detail].filter(Boolean).join(' ');
    const key = ask.kind === 'command' ? `command:${label}` : `other:${ask.tool}:${ask.detail ?? ''}`;
    if (sessionAllowed.has(key)) return { allow: true };
    const answer = await deps.askHuman({ kind: 'command', command: label, ask });
    if (!allows(answer)) {
      return { allow: false, message: ask.kind === 'command'
        ? `Align: the person declined to run \`${label}\`. Ask them before trying another way.`
        : `Align: the person declined the ${ask.tool} tool. Ask them before trying another way.` };
    }
    if (answer === 'allow-session') sessionAllowed.add(key);
    return { allow: true };
  };
}
