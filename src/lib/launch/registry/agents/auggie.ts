import { buildAuggieLaunch } from '../../adapters/auggie.js';
import type { AgentSpec } from '../types.js';

export const auggie: AgentSpec = {
  name: 'auggie',
  label: 'Auggie',
  bin: 'auggie',
  injection: 'written-once',
  supported: true,
  install: { kind: 'npm', argv: ['npm', 'i', '-g', '@augmentcode/auggie'] },
  build: (d, base) => buildAuggieLaunch({ passthrough: base.passthrough, ...d.readAuggieState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
