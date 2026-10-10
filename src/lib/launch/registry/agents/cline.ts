import { buildClineLaunch } from '../../adapters/cline.js';
import type { AgentSpec } from '../types.js';

export const cline: AgentSpec = {
  name: 'cline',
  label: 'Cline',
  bin: 'cline',
  injection: 'written-once',
  supported: true,
  install: { kind: 'npm', argv: ['npm', 'i', '-g', 'cline'] },
  build: (d, base) => buildClineLaunch({ passthrough: base.passthrough, ...d.readClineState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
