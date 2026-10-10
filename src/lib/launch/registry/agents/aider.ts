import { buildAiderLaunch } from '../../adapters/aider.js';
import { aiderReadHasBlock } from '../../aider-state.js';
import type { AgentSpec } from '../types.js';

export const aider: AgentSpec = {
  name: 'aider',
  label: 'Aider',
  bin: 'aider',
  injection: 'per-session',
  supported: true,
  // No MCP in Aider: instructions only, never the graph tools.
  graph: false,
  install: { kind: 'docs', url: 'https://aider.chat/docs/install.html', text: 'python -m pip install aider-install && aider-install' },
  build: (d, base) => buildAiderLaunch({ ...base, readHasBlock: aiderReadHasBlock(d.cwd, base.passthrough) }),
};
