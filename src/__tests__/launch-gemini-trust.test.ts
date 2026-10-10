import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiFolderTrust, geminiSystemDefaultsPath } from '../lib/launch/gemini-trust.js';

/*
 * Gemini CLI 0.58.0 turns off EVERY MCP server in a folder it does not trust. The rules, read
 * from its bundled source (packages/core/src/utils/trust.ts, cli/src/config/trustedFolders.ts):
 *  - GEMINI_CLI_TRUST_WORKSPACE=true|false decides outright
 *  - security.folderTrust.enabled (default true; system-defaults < user < system) false -> off
 *  - else the LONGEST matching rule path in trustedFolders.json wins; TRUST_PARENT matches the
 *    rule's parent dir; DO_NOT_TRUST distrusts; no match is untrusted
 *  - a match is "is a subpath", so /a/b never trusts /a/bc
 * align reads this and never writes it.
 */
let root: string;
let home: string;
const gdir = () => path.join(home, '.gemini');
const rules = (r: Record<string, string>) => writeFileSync(path.join(gdir(), 'trustedFolders.json'), JSON.stringify(r));
const dir = (...p: string[]) => {
  const d = path.join(root, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
// The real filesystem paths below follow the HOST's path rules, so the default platform is the
// host's. Hardcoding 'linux' made path.posix read Windows paths as one opaque segment on the
// windows-launch job: exact matches held, nothing nested, and system-defaults.json was lost.
// These tests are about the trust RULES, so the ownership rule is out of the way (null = Gemini reads every file);
// the last describe covers the ownership filter itself.
const trust = (cwd: string, env: Record<string, string | undefined> = {}, platform: string = process.platform) =>
  geminiFolderTrust(cwd, home, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, 'no-system.json'), ...env }, platform, () => null);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'align-gemini-trust-'));
  home = path.join(root, 'home');
  mkdirSync(gdir(), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('geminiFolderTrust: trustedFolders.json', () => {
  it('trusts the exact folder with TRUST_FOLDER, and a folder below it', () => {
    const proj = dir('ws', 'proj');
    rules({ [proj]: 'TRUST_FOLDER' });
    expect(trust(proj)).toBe('trusted');
    expect(trust(dir('ws', 'proj', 'src'))).toBe('trusted');
  });

  it('does not trust a sibling whose name only starts with the trusted path (/a/b vs /a/bc)', () => {
    rules({ [dir('ws', 'proj')]: 'TRUST_FOLDER' });
    expect(trust(dir('ws', 'projx'))).toBe('untrusted');
    expect(trust(dir('ws'))).toBe('untrusted');
  });

  it('TRUST_PARENT trusts the rule path\'s parent, so a sibling of the rule is trusted', () => {
    rules({ [dir('ws', 'projA')]: 'TRUST_PARENT' });
    expect(trust(dir('ws', 'projB'))).toBe('trusted');
    expect(trust(dir('other'))).toBe('untrusted');
  });

  it('the longest matching rule wins: DO_NOT_TRUST inside a trusted tree distrusts only that subtree', () => {
    rules({ [dir('ws')]: 'TRUST_FOLDER', [dir('ws', 'secret')]: 'DO_NOT_TRUST' });
    expect(trust(dir('ws', 'secret', 'x'))).toBe('untrusted');
    expect(trust(dir('ws', 'open'))).toBe('trusted');
  });

  it('the longest rule wins whatever order the file lists them in', () => {
    rules({ [dir('ws', 'secret')]: 'DO_NOT_TRUST', [dir('ws')]: 'TRUST_FOLDER' });
    expect(trust(dir('ws', 'secret', 'x'))).toBe('untrusted');
    rules({ [dir('ws', 'open')]: 'TRUST_FOLDER', [dir('ws')]: 'DO_NOT_TRUST' });
    expect(trust(dir('ws', 'open', 'y'))).toBe('trusted');
  });

  it('no rule, or no file at all, is untrusted (Gemini treats "no rule" as not trusted)', () => {
    expect(trust(dir('p'))).toBe('untrusted');
    rules({ [dir('elsewhere')]: 'TRUST_FOLDER' });
    expect(trust(dir('p'))).toBe('untrusted');
  });

  it('an unreadable or invalid file is unknown, not trusted', () => {
    writeFileSync(path.join(gdir(), 'trustedFolders.json'), '{not json');
    expect(trust(dir('p'))).toBe('unknown');
    rules({ [dir('p')]: 'TRUST_EVERYTHING' });
    expect(trust(dir('p'))).toBe('unknown');
    writeFileSync(path.join(gdir(), 'trustedFolders.json'), '[]');
    expect(trust(dir('p'))).toBe('unknown');
  });

  it('matches case-insensitively on darwin and win32, case-sensitively on linux', () => {
    rules({ '/Fake/Root/Proj': 'TRUST_FOLDER' });
    expect(trust('/fake/root/proj', {}, 'darwin')).toBe('trusted');
    expect(trust('/fake/root/proj', {}, 'linux')).toBe('untrusted');
  });

  it('reads GEMINI_CLI_TRUSTED_FOLDERS_PATH and GEMINI_CLI_HOME when set', () => {
    const proj = dir('p');
    const alt = path.join(root, 'alt-trust.json');
    writeFileSync(alt, JSON.stringify({ [proj]: 'TRUST_FOLDER' }));
    expect(trust(proj, { GEMINI_CLI_TRUSTED_FOLDERS_PATH: alt })).toBe('trusted');
    const ghome = dir('ghome');
    mkdirSync(path.join(ghome, '.gemini'));
    writeFileSync(path.join(ghome, '.gemini', 'trustedFolders.json'), JSON.stringify({ [proj]: 'TRUST_FOLDER' }));
    expect(trust(proj, { GEMINI_CLI_HOME: ghome })).toBe('trusted');
    expect(trust(proj)).toBe('untrusted');
  });

  it('reads a trustedFolders.json with comments, as Gemini does', () => {
    const proj = dir('p');
    writeFileSync(path.join(gdir(), 'trustedFolders.json'), `// mine\n{ ${JSON.stringify(proj)}: /* yes */ "TRUST_FOLDER" }`);
    expect(trust(proj)).toBe('trusted');
    expect(trust(dir('q'))).toBe('untrusted');
  });

  it('resolves symlinks on both sides: a linked cwd under a trusted real dir, and a linked rule over a real cwd', () => {
    const real = dir('real', 'proj');
    const link = path.join(root, 'link');
    symlinkSync(path.join(root, 'real'), link);
    rules({ [real]: 'TRUST_FOLDER' });
    expect(trust(path.join(link, 'proj'))).toBe('trusted');
    rules({ [path.join(link, 'proj')]: 'TRUST_FOLDER' });
    expect(trust(real)).toBe('trusted');
    rules({ [path.join(link, 'other')]: 'TRUST_FOLDER' });
    expect(trust(real)).toBe('untrusted');
  });

  it('never writes trustedFolders.json: absent stays absent, present stays byte-identical', () => {
    const file = path.join(gdir(), 'trustedFolders.json');
    trust(dir('p'));
    expect(existsSync(file)).toBe(false);
    rules({ [dir('q')]: 'TRUST_FOLDER' });
    const before = readFileSync(file, 'utf8');
    trust(dir('p'));
    trust(dir('q'));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('geminiFolderTrust: what overrides the file', () => {
  it('GEMINI_CLI_TRUST_WORKSPACE decides outright, both ways', () => {
    const proj = dir('p');
    rules({ [proj]: 'TRUST_FOLDER' });
    expect(trust(proj, { GEMINI_CLI_TRUST_WORKSPACE: 'false' })).toBe('untrusted');
    expect(trust(dir('q'), { GEMINI_CLI_TRUST_WORKSPACE: 'true' })).toBe('trusted');
  });

  it('folder trust turned off in user settings (JSONC) is off; the system file overrides the user', () => {
    const proj = dir('p');
    writeFileSync(path.join(gdir(), 'settings.json'), '// mine\n{ "security": { "folderTrust": { "enabled": false /* off */ } } }');
    expect(trust(proj)).toBe('off');
    const sys = path.join(root, 'system.json');
    writeFileSync(sys, JSON.stringify({ security: { folderTrust: { enabled: true } } }));
    expect(trust(proj, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: sys })).toBe('untrusted');
  });

  it('system defaults sit below the user: defaults off, user on -> still checks the folder', () => {
    const proj = dir('p');
    const sysDir = dir('etc');
    writeFileSync(path.join(sysDir, 'system-defaults.json'), JSON.stringify({ security: { folderTrust: { enabled: false } } }));
    const env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(sysDir, 'settings.json') };
    expect(trust(proj, env)).toBe('off');
    writeFileSync(path.join(gdir(), 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: true } } }));
    expect(trust(proj, env)).toBe('untrusted');
  });
});

describe('geminiFolderTrust on win32, simulated on any host (synthetic paths, so realpath leaves them as written)', () => {
  const WS = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x\\ws';
  const win = (cwd: string) => geminiFolderTrust(cwd, home, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, 'no-system.json') }, 'win32');

  it('a folder below a TRUST_FOLDER rule is trusted; a sibling sharing the prefix is not', () => {
    rules({ [`${WS}\\proj`]: 'TRUST_FOLDER' });
    expect(win(`${WS}\\proj`)).toBe('trusted');
    expect(win(`${WS}\\proj\\src\\deep`)).toBe('trusted');
    expect(win(`${WS}\\projx`)).toBe('untrusted');
  });

  it('drive letter and case fold the way Gemini\'s normalizePath does, and a forward-slash rule matches', () => {
    rules({ 'C:/Users/RUNNER~1/AppData/Local/Temp/x/ws/proj': 'TRUST_FOLDER' });
    expect(win('c:\\users\\runner~1\\appdata\\local\\temp\\x\\WS\\PROJ\\src')).toBe('trusted');
  });

  it('TRUST_PARENT trusts the rule\'s parent; the longest rule wins whatever the order', () => {
    rules({ [`${WS}\\projA`]: 'TRUST_PARENT' });
    expect(win(`${WS}\\projB`)).toBe('trusted');
    rules({ [`${WS}\\secret`]: 'DO_NOT_TRUST', [WS]: 'TRUST_FOLDER' });
    expect(win(`${WS}\\secret\\x`)).toBe('untrusted');
    expect(win(`${WS}\\open`)).toBe('trusted');
  });

  it('system-defaults.json is found beside a Windows system settings path', () => {
    expect(geminiSystemDefaultsPath('C:\\ProgramData\\gemini-cli\\settings.json', 'win32')).toBe('C:\\ProgramData\\gemini-cli\\system-defaults.json');
    expect(geminiSystemDefaultsPath('/etc/gemini-cli/settings.json', 'linux')).toBe('/etc/gemini-cli/system-defaults.json');
  });

  it('control: the SAME Windows paths under posix rules nest nothing (the CI failure mode)', () => {
    rules({ [`${WS}\\proj`]: 'TRUST_FOLDER' });
    expect(geminiFolderTrust(`${WS}\\proj\\src`, home, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, 'no-system.json') }, 'linux')).toBe('untrusted');
  });
});

describe('geminiFolderTrust: system files Gemini rejects do not decide the verdict', () => {
  const disable = (file: string) => writeFileSync(file, JSON.stringify({ security: { folderTrust: { enabled: false } } }));
  const enable = (file: string) => writeFileSync(file, JSON.stringify({ security: { folderTrust: { enabled: true } } }));
  const rejectAll = () => 'not owned by root';
  const rejectNone = () => null;
  const sysPath = () => path.join(root, 'sys.json');
  const t = (cwd: string, rejects: (f: string, p: string) => string | null) =>
    geminiFolderTrust(cwd, home, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: sysPath() }, process.platform, rejects);

  it('misleading direction: a rejected system file saying enabled:false does NOT turn trust off', () => {
    disable(sysPath());
    const proj = dir('p');
    expect(t(proj, rejectAll)).toBe('untrusted');
    expect(t(proj, rejectNone)).toBe('off');
  });

  it('dangerous direction: a rejected system file saying enabled:true does not override the user\'s enabled:false', () => {
    writeFileSync(path.join(gdir(), 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: false } } }));
    enable(sysPath());
    const proj = dir('p');
    expect(t(proj, rejectAll)).toBe('off');
    expect(t(proj, rejectNone)).toBe('untrusted');
  });

  it('the user file is never ownership-checked by Gemini, so it always counts', () => {
    writeFileSync(path.join(gdir(), 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: false } } }));
    expect(t(dir('p'), rejectAll)).toBe('off');
  });

  it('GEMINI_RESTRICTED_MODE=true beats GEMINI_CLI_TRUST_WORKSPACE=true', () => {
    const env = { GEMINI_RESTRICTED_MODE: 'true', GEMINI_CLI_TRUST_WORKSPACE: 'true' };
    expect(geminiFolderTrust(dir('p'), home, env, process.platform, rejectNone)).toBe('untrusted');
  });
});
