import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface AiderLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'> {
  /** A `--read` file of the user's already carries Align's block. */
  readHasBlock: boolean;
}

const FILE = 'aider-align-instructions.md';

/**
 * Aider has no MCP, so it gets instructions and no graph tools. The model cannot call Align, so the
 * text asks it to send the user to Align in another terminal.
 */
export const AIDER_INSTRUCTIONS = `# Align (decision graph)

This project's decisions live in Align, but this Aider session has no MCP and so no graph tools:
you cannot query Align yourself.

- Before a change that could touch a past decision (architecture, data model, a dependency, a
  config value someone chose), stop and ask the user to run, in another terminal:
  \`align ask "<what you are about to change and why>"\`
- After editing, suggest the user runs \`align check\` in another terminal to compare the diff
  against recorded decisions.
- If the user reports a conflict, follow the recorded decision or confirm with them first.
`;

/**
 * Aider, per session, instructions only (aider 0.86.2, `aider --help`): `--read FILE` loads a
 * read-only file into the chat, and can be given more than once, so the user's own `--read`
 * files are kept. The flag goes first, where a user's `--` cannot turn it into a file name.
 * Nothing else is passed: no `--lint-cmd` (plan Open Question 8), no `--yes-always`.
 */
export function buildAiderLaunch(c: AiderLaunchContext): LaunchSpec {
  const spec: LaunchSpec = { bin: 'aider', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [] };
  if (c.readHasBlock) return spec;
  return { ...spec, args: ['--read', c.cachePath(FILE), ...c.passthrough], files: [{ name: FILE, content: AIDER_INSTRUCTIONS }] };
}
