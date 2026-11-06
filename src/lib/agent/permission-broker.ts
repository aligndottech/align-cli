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

/** Tools whose second word is the real command (`npm test` vs `npm publish`). */
const TWO_WORD = new Set(['npm', 'pnpm', 'yarn', 'git', 'npx']);

function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/);
  return TWO_WORD.has(words[0] ?? '') ? words.slice(0, 2).join(' ') : (words[0] ?? '');
}

function decisionLine(d: GateDecision): string {
  return [`- ${d.title}`, d.why ? ` - ${d.why}` : '', d.url ? ` (${d.url})` : ''].join('');
}

function stopMessage(outcome: Extract<GateOutcome, { kind: 'ask' }>): string {
  const lead = outcome.reason === 'conflict'
    ? 'Align: the person stopped this edit. It conflicts with a recorded decision:'
    : 'Align: the person stopped this edit. It changes lines written by a recorded decision:';
  return [lead, ...outcome.cards.map(decisionLine), 'Do not retry this edit. Ask the person how they want to proceed.'].join('\n');
}

export function createBroker(deps: BrokerDeps): (ask: ToolAsk) => Promise<BrokerVerdict> {
  const sessionAllowed = new Set<string>();

  return async (ask) => {
    if (ask.kind === 'edit') {
      const outcome = await deps.gate(ask);
      deps.onGate(outcome, ask);
      if (outcome.kind === 'allow') return { allow: true };
      const answer = await deps.askHuman({ kind: 'gate', outcome, ask });
      return answer === 'stop' ? { allow: false, message: stopMessage(outcome) } : { allow: true };
    }
    if (ask.kind === 'command') {
      const command = ask.command ?? '';
      if (sessionAllowed.has(commandPrefix(command))) return { allow: true };
      const answer = await deps.askHuman({ kind: 'command', command, ask });
      if (answer === 'stop') return { allow: false, message: `Align: the person declined to run \`${command}\`. Ask them before trying another way.` };
      if (answer === 'allow-session') sessionAllowed.add(commandPrefix(command));
      return { allow: true };
    }
    return { allow: true };
  };
}
