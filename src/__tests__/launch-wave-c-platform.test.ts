import { afterAll, describe, expect, it } from 'vitest';
import { buildAuggieLaunch } from '../lib/launch/adapters/auggie.js';
import { buildClineLaunch } from '../lib/launch/adapters/cline.js';
import { buildContinueLaunch } from '../lib/launch/adapters/continue.js';
import { buildGooseLaunch } from '../lib/launch/adapters/goose.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * What the wave C writers emit is platform-conditional (ALI-1135): an npm global install on
 * Windows is `align.cmd`, which a client cannot spawn without a shell, so every entry goes through
 * `cmd /c`. Both sides are pinned here, so neither depends on the runner (tdd.md, "a test must
 * establish its own preconditions"). Windows is simulated: these builders are pure.
 */
afterAll(() => restorePlatform());

const WIN = { command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] };
const POSIX = { command: 'align', args: ['mcp', '--env', 'local'] };

describe.each([['win32', WIN], ['linux', POSIX]] as const)('on %s', (platform, spawn) => {
  it('goose: the --with-extension command is the platform spawn form', () => {
    setPlatform(platform);
    const s = buildGooseLaunch({ present: false, configFile: '/c', passthrough: [] });
    expect(s.args).toEqual(['session', '--with-extension', `align-local:${[spawn.command, ...spawn.args].join(' ')}`]);
  });
  it('continue: the block file\'s command and args are the platform spawn form', () => {
    setPlatform(platform);
    const s = buildContinueLaunch({ present: false, configFile: '/c', cachePath: (n) => `/cache/${n}`, passthrough: [], env: {} });
    expect(s.files[0]!.content).toContain(`    command: ${JSON.stringify(spawn.command)}\n    args: [${spawn.args.map((a) => JSON.stringify(a)).join(', ')}]\n`);
  });
  it('auggie and cline: the written entry is the platform spawn form', () => {
    setPlatform(platform);
    expect(buildAuggieLaunch({ present: false, overridden: [], settingsFile: '/s', commented: false, passthrough: [] }).writes![0]!.entry).toEqual(spawn);
    const cline = buildClineLaunch({ present: false, overridden: [], mcpFile: '/m', oneSession: false, passthrough: [], env: {} }).writes![0]!.entry;
    expect({ command: cline['command'], args: cline['args'] }).toEqual(spawn);
  });
});

describe('continue: the --mcp value for a Windows cache path is what cn decodes to that path', () => {
  // cn 1.5.47 decodePackageIdentifier: a value starting `file://` is a file, and its path is the
  // value with those 7 characters removed. So `file://` + the path, NOT pathToFileURL: that gives
  // `file:///C:/...`, which cn would decode to `/C:/...`, a path that does not exist on Windows.
  const cnDecode = (v: string): string | null => (v.startsWith('file://') ? v.substring(7) : null);
  it('C:\\ paths round-trip; a POSIX path does too', () => {
    for (const dir of ['C:\\Users\\u\\AppData\\Local\\align-cli\\Cache\\launch', '/home/u/.cache/align-cli/launch']) {
      const s = buildContinueLaunch({ present: false, configFile: '/c', cachePath: (n) => `${dir}/${n}`, passthrough: [], env: {} });
      expect(cnDecode(s.args[1]!)).toBe(`${dir}/continue-align-local.yaml`);
    }
  });
});
