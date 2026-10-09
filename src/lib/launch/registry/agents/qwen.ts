import { buildQwenLaunch } from '../../adapters/qwen.js';
import type { AgentSpec } from '../types.js';

export const qwen: AgentSpec = {
  name: 'qwen',
  label: 'Qwen Code',
  bin: 'qwen',
  injection: 'per-session',
  supported: true,
  install: { kind: 'npm', argv: ['npm', 'i', '-g', '@qwen-code/qwen-code'] },
  build: (d, base) => buildQwenLaunch({ ...base, env: d.env, platform: d.platform, ...d.readQwenState!(d.cwd, d.home, d.env, d.platform) }),
};
