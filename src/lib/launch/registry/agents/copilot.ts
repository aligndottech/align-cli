import { buildCopilotLaunch } from '../../adapters/copilot.js';
import type { AgentSpec } from '../types.js';

export const copilot: AgentSpec = {
  name: 'copilot',
  label: 'GitHub Copilot CLI',
  bin: 'copilot',
  injection: 'per-session',
  supported: true,
  install: { kind: 'npm', argv: ['npm', 'i', '-g', '@github/copilot'] },
  build: (d, base) => buildCopilotLaunch({ ...base, ...d.readCopilotState(d.cwd, d.home, d.env, d.platform) }),
};
