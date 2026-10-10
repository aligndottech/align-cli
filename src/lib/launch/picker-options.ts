import type { LaunchAgent } from './agents.js';
import type { InstallOutcome } from './install.js';
import { specByName } from './registry/index.js';
import type { LaunchAgentId } from './registry/types.js';

export interface PickerOption {
  value: LaunchAgentId;
  label: string;
  hint?: string;
}

/** Code-unit order, never locale order: the same list on every machine. */
const byLabel = (a: LaunchAgent, b: LaunchAgent): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/**
 * Every agent Align supports, for the "which coding agent?" picker: the installed ones first,
 * then the rest, each by label, the rest marked with how to install them. Built from whatever
 * list it is given, so a new registry spec appears with no change here.
 */
export function pickerOptions(agents: readonly LaunchAgent[], isInstalled: (a: LaunchAgent) => boolean): PickerOption[] {
  const installed = agents.filter(isInstalled).sort(byLabel);
  const missing = agents.filter((a) => !isInstalled(a)).sort(byLabel);
  // An agent Align can give instructions but no graph tools (Aider) says so in its row.
  const noGraph = (a: LaunchAgent): boolean => specByName(a.name)?.graph === false;
  const NO_GRAPH = 'instructions only: no graph tools';
  const label = (a: LaunchAgent): string => (noGraph(a) ? `${a.label} (${NO_GRAPH})` : a.label);
  return [
    ...installed.map((a) => ({ value: a.name, label: label(a) })),
    ...missing.map((a) => ({ value: a.name, label: `${label(a)} (not installed)`, hint: `install: ${a.install}` })),
  ];
}

export interface ChooseDeps {
  isInstalled(a: LaunchAgent): boolean;
  /** Resolves null when the user cancels. `initial` is the row the cursor starts on. */
  select(options: PickerOption[], initial?: LaunchAgentId): Promise<LaunchAgentId | null>;
  /** Decision 4: offer to install a picked agent that is missing (install.ts). */
  offer(a: LaunchAgent): Promise<InstallOutcome>;
  say(line: string): void;
}

/**
 * Show the picker until the user picks an installed agent (or one that installs and is then
 * found on PATH) or cancels, at the picker or at the install question. A plain No, a printed
 * installer or a failed install returns to the picker. With exactly one agent installed the
 * cursor starts on it, so Enter keeps what bare `align` used to pick without asking.
 */
export async function chooseAgent(agents: readonly LaunchAgent[], d: ChooseDeps): Promise<LaunchAgent | null> {
  for (;;) {
    const installed = agents.filter(d.isInstalled);
    const initial = installed.length === 1 ? installed[0]!.name : undefined;
    const name = await d.select(pickerOptions(agents, d.isInstalled), initial);
    const chosen = agents.find((a) => a.name === name);
    if (!chosen) return null;
    if (d.isInstalled(chosen)) return chosen;
    const outcome = await d.offer(chosen);
    if (outcome === 'cancelled') return null;
    if (outcome === 'installed') {
      if (d.isInstalled(chosen)) return chosen;
      d.say(`${chosen.label} installed, but ${chosen.bin} is still not on your PATH. Open a new terminal, or pick another.`);
    }
  }
}
