import * as p from '@clack/prompts';
import { type AgentConfig, type PickDeferred, storeChosenAgent } from '../launch/pick-agent.js';
import { detectEditors, type EditorTarget } from '../mcp-setup.js';
import { type PlannedWrite, planSetupWrites, renderWritePlan, WRITE_UNDO_LINE } from '../write-confirm.js';

/** The answer that writes nothing. Not an agent name, so it cannot collide with one. */
export const NO_WRITES = ':no-writes';

/**
 * One screen for two questions, when two or more coding agents are installed: the files setup
 * writes, then which agent opens. Answering with an agent confirms the files; "Do not write
 * anything" confirms nothing and picks no agent. With no files to write it only asks the agent.
 */
export async function askAgentAndWrites(o: {
  files: PlannedWrite[];
  agents: Array<{ name: string; label: string }>;
  print: (text: string) => void;
  /** Resolves to the chosen value, or undefined on a cancel. */
  select: (message: string, options: Array<{ value: string; label: string }>) => Promise<string | undefined>;
}): Promise<{ agent: string | null; confirmed: boolean } | 'cancelled'> {
  const writes = o.files.length > 0;
  if (writes) o.print(`${renderWritePlan(o.files)}\n${WRITE_UNDO_LINE}`);
  const options = [
    ...o.agents.map((a) => ({ value: a.name, label: a.label })),
    ...(writes ? [{ value: NO_WRITES, label: 'Do not write anything' }] : []),
  ];
  const answer = await o.select(writes ? 'Write these files, then open which agent?' : 'Which agent should Align open?', options);
  if (answer === undefined) return 'cancelled';
  if (answer === NO_WRITES) return { agent: null, confirmed: false };
  return { agent: answer, confirmed: true };
}

/** Setup's side of the combined screen: plans the files, asks with clack, and stores the agent chosen. */
export async function confirmAgentAndWrites(deferred: PickDeferred['deferred'], config: AgentConfig): Promise<{ agent: string | null; confirmed: boolean; editors: EditorTarget[] } | 'cancelled'> {
  const editors = detectEditors();
  console.log('');
  const answer = await askAgentAndWrites({
    files: planSetupWrites({ cwd: process.cwd(), editors }),
    agents: deferred,
    print: (text) => p.log.info(text),
    select: async (message, options) => {
      const a = await p.select({ message, options, initialValue: options[0]?.value });
      return p.isCancel(a) ? undefined : String(a);
    },
  });
  if (answer === 'cancelled') return answer;
  if (answer.agent) storeChosenAgent(config, answer.agent, (l) => p.log.info(l));
  return { ...answer, editors };
}
