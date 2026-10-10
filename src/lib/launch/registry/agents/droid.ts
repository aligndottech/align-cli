import { buildDroidLaunch } from '../../adapters/droid.js';
import type { AgentSpec } from '../types.js';

export const droid: AgentSpec = {
  name: 'droid',
  label: 'Factory Droid',
  bin: 'droid',
  injection: 'per-session',
  supported: true,
  // The npm package's binary arrives by a postinstall script, which npm 12 no longer runs
  // without approval, so the vendor's documented script is what Align prints (never runs).
  install: { kind: 'docs', url: 'https://docs.factory.ai/cli/getting-started/quickstart', text: 'curl -fsSL https://app.factory.ai/cli | sh' },
  // Not runnable here; pinned fail closed to the home Align read ~/.factory from.
  pins: (d) => ({ FACTORY_HOME_OVERRIDE: d.home }),
  build: (d, base) => buildDroidLaunch({ ...base, ...d.readDroidState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
