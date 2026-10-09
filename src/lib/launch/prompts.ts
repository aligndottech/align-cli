import type { Writable } from 'node:stream';
import type { PickerOption } from './picker-options.js';
import type { LaunchAgentId } from './registry/types.js';

/*
 * The two clack prompts behind the agent picker, shared by bare `align` and the wizard. clack is
 * imported on use, never at module load, so the launch path pays nothing for it (cost rule).
 */

/** "Which coding agent?". Resolves null on cancel. `initial` is the row the cursor starts on. */
export async function selectAgent(options: PickerOption[], initial: LaunchAgentId | undefined, output?: Writable): Promise<LaunchAgentId | null> {
  const clack = await import('@clack/prompts');
  const answer = await clack.select({
    message: 'Which coding agent should `align` open?',
    options,
    ...(initial !== undefined ? { initialValue: initial } : {}),
    ...(output ? { output } : {}),
  });
  return clack.isCancel(answer) ? null : (answer as LaunchAgentId);
}

/**
 * A yes/no question with No preselected. true only on an explicit yes, false on anything else,
 * null on Ctrl-C (which the picker treats as leaving it, not as a No).
 */
export async function confirmDefaultNo(message: string, output?: Writable): Promise<boolean | null> {
  const clack = await import('@clack/prompts');
  const answer = await clack.confirm({ message, initialValue: false, ...(output ? { output } : {}) });
  if (clack.isCancel(answer)) return null;
  return answer === true;
}
