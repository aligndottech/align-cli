import { buildOpenCodeLaunch } from '../../adapters/opencode.js';
import type { AgentSpec } from '../types.js';

export const opencode: AgentSpec = {
  name: 'opencode',
  label: 'OpenCode',
  bin: 'opencode',
  injection: 'per-session',
  supported: true,
  install: 'npm i -g opencode-ai',
  build: (d, base) => buildOpenCodeLaunch({ ...base, env: d.env, ...d.readOpenCodeState(d.cwd, d.home) }),
};
