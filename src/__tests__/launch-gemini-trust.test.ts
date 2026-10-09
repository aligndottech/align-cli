import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiFolderTrust } from '../lib/launch/gemini-trust.js';

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
const trust = (cwd: string, env: Record<string, string | undefined> = {}, platform = 'linux') =>
  geminiFolderTrust(cwd, home, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, 'no-system.json'), ...env }, platform);

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

  it('folder trust turned off in user settings is off; the system file overrides the user', () => {
    const proj = dir('p');
    writeFileSync(path.join(gdir(), 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: false } } }));
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
