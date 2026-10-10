import { buildAmpLaunch } from '../../adapters/amp.js';
import { ampSettingsFile } from '../../amp-state.js';
import { optionValue } from '../../layer-files.js';
import type { AgentSpec } from '../types.js';

export const amp: AgentSpec = {
  name: 'amp',
  label: 'Amp',
  bin: 'amp',
  injection: 'written-once',
  supported: true,
  // @sourcegraph/amp places its native binary in a postinstall script that npm 12 skips without
  // approval (seen in a sandbox install: the `amp` it left only prints an error), so Align
  // prints Amp's documented script installer instead and never runs it.
  install: { kind: 'docs', url: 'https://ampcode.com/manual', text: 'curl -fsSL https://ampcode.com/install.sh | bash' },
  // Not runnable here; pinned fail closed (a `.env` loader cannot move it). --settings-file wins anyway.
  pins: (d, base): Record<string, string> => (optionValue(base.passthrough, '--settings-file') ? {} : { AMP_SETTINGS_FILE: ampSettingsFile(d.home, d.env, base.passthrough) }),
  build: (d, base) => buildAmpLaunch({ passthrough: base.passthrough, ...d.readAmpState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
