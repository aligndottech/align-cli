import { buildClaudeLaunch } from '../../adapters/claude-code.js';
import type { AgentSpec } from '../types.js';

export const claudeCode: AgentSpec = {
  name: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  injection: 'per-session',
  supported: true,
  install: 'npm i -g @anthropic-ai/claude-code',
  build: (d, base) => buildClaudeLaunch({ ...base, ...d.readProjectState(d.cwd, d.home) }),
};
