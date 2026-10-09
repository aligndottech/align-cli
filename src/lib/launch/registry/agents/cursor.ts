import { buildCursorLaunch } from '../../adapters/cursor.js';
import type { AgentSpec } from '../types.js';

export const cursor: AgentSpec = {
  name: 'cursor',
  label: 'Cursor',
  bin: 'cursor-agent',
  injection: 'written-once',
  supported: true,
  install: { kind: 'docs', url: 'https://cursor.com/cli' },
  build: (d, base) => buildCursorLaunch({ ...base, ...d.readCursorState(d.cwd, d.home) }),
};
