import { buildAmpLaunch } from '../../adapters/amp.js';
import type { AgentSpec } from '../types.js';

export const amp: AgentSpec = {
  name: 'amp',
  label: 'Amp',
  bin: 'amp',
  injection: 'per-session',
  supported: true,
  // @sourcegraph/amp places its native binary in a postinstall script that npm 12 skips without
  // approval (seen in a sandbox install: the `amp` it left only prints an error), so Align
  // prints Amp's documented script installer instead and never runs it.
  install: { kind: 'docs', url: 'https://ampcode.com/manual', text: 'curl -fsSL https://ampcode.com/install.sh | bash' },
  build: (d, base) => buildAmpLaunch({ ...base, ...d.readAmpState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
