import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';
import { createTokenVault, selectBackend, type TokenVault } from '../lib/token-store.js';
import { fakeTool, type FakeTool } from './helpers/fake-os-secret-tools.js';

// In-memory conf, exposing the raw map so a test can see what would be written to disk.
const disk = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('conf', () => ({
  default: class {
    constructor(opts: Record<string, unknown>) { disk.data = JSON.parse(JSON.stringify(opts['defaults'] ?? {})) as Record<string, unknown>; }
    get(k: string) { return disk.data[k]; }
    set(k: string, v: unknown) { disk.data[k] = JSON.parse(JSON.stringify(v)); }
    has(k: string) { return k in disk.data; }
  },
}));

const fileTokens = (): Record<string, string> => disk.data['connectorTokens'] as Record<string, string>;
const TOKEN = 'ghp_ReadOnlyTokenValue0123456789';
const ENV_KEYS = ['ALIGN_GITHUB_TOKEN', 'ALIGN_JIRA_TOKEN', 'ALIGN_JIRA_EMAIL', 'ALIGN_JIRA_DOMAIN', 'ALIGN_GITLAB_TOKEN', 'ALIGN_GITLAB_DOMAIN'];

let tool: FakeTool;
let notes: string[];
let vault: TokenVault;
const open = () => createConfigStore({ vault });

beforeEach(() => {
  // Both sides of every env var are set by the test itself, never inherited from the runner or a developer shell.
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  tool = fakeTool('secret-tool');
  notes = [];
  vault = createTokenVault({ selection: selectBackend({ platform: 'linux', run: tool.run }), notify: (m) => notes.push(m) });
});

describe('saving a token', () => {
  it('puts the token in the keychain and leaves no plaintext copy in the config file', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    expect(tool.store.get('local:github')).toBe(TOKEN);
    expect(JSON.stringify(disk.data)).not.toContain(TOKEN);
  });

  it('keeps the non-secret extra fields in the file and still reads them back with the token', () => {
    const config = open();
    config.saveConnectorFields('local', 'jira', { token: TOKEN, email: 'a@b.co', domain: 'x.atlassian.net' });
    expect(fileTokens()['local:jira:field:email']).toBe('a@b.co');
    expect(config.getConnectorFields('local', 'jira')).toEqual({ token: TOKEN, email: 'a@b.co', domain: 'x.atlassian.net' });
  });

  it('falls back to the file when there is no keychain, says so once, and the token stays readable', () => {
    tool.breakIt('no secret service');
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    config.saveConnectorFields('local', 'slack', { token: 'xoxp-1' });
    expect(fileTokens()['local:github']).toBe(TOKEN);
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: TOKEN });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('no secret service');
  });

  it('a write the keychain swallowed keeps the plaintext, so the token is not lost', () => {
    tool.swallowWrites();
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: TOKEN });
    expect(fileTokens()['local:github']).toBe(TOKEN);
  });

  it('still refuses an empty token', () => {
    expect(() => open().saveConnectorFields('local', 'github', { token: '' })).toThrow(/non-empty/);
  });

  it('the OAuth token path (setConnectorToken) uses the keychain too', () => {
    const config = open();
    config.setConnectorToken('prod', 'jira-personal', 'oauth-access');
    expect(tool.store.get('prod:jira-personal')).toBe('oauth-access');
    expect(fileTokens()['prod:jira-personal']).toBeUndefined();
    expect(config.getConnectorToken('prod', 'jira-personal')).toBe('oauth-access');
  });
});

describe('migrating a plaintext token that an older version wrote', () => {
  it('moves it into the keychain on the next read and removes the plaintext copy', () => {
    const config = open();
    disk.data['connectorTokens'] = { 'local:github': TOKEN, 'local:jira:field:email': 'a@b.co' };
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: TOKEN });
    expect(tool.store.get('local:github')).toBe(TOKEN);
    expect(fileTokens()['local:github']).toBeUndefined();
    // The extra field is not a secret and stays where it was.
    expect(fileTokens()['local:jira:field:email']).toBe('a@b.co');
  });

  it('a failed migration leaves the token readable in the file', () => {
    tool.breakIt('keychain locked');
    const config = open();
    disk.data['connectorTokens'] = { 'local:github': TOKEN };
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: TOKEN });
    expect(fileTokens()['local:github']).toBe(TOKEN);
  });

  it('a migration the keychain swallowed keeps the plaintext', () => {
    tool.swallowWrites();
    const config = open();
    disk.data['connectorTokens'] = { 'local:github': TOKEN };
    config.getConnectorFields('local', 'github');
    expect(fileTokens()['local:github']).toBe(TOKEN);
  });

  it('a plaintext copy newer than the keychain wins and replaces it', () => {
    tool.store.set('local:github', 'old-token');
    const config = open();
    disk.data['connectorTokens'] = { 'local:github': TOKEN };
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: TOKEN });
    expect(tool.store.get('local:github')).toBe(TOKEN);
  });

  it('a token already in the keychain is read from it', () => {
    tool.store.set('local:github', TOKEN);
    expect(open().getConnectorFields('local', 'github')).toEqual({ token: TOKEN });
  });

  it('a source with nothing anywhere is not connected', () => {
    expect(open().getConnectorFields('local', 'github')).toBeNull();
  });
});

describe('forgetting', () => {
  it('forgetConnector deletes the keychain entry, the fields and the file copy', () => {
    const config = open();
    config.saveConnectorFields('local', 'jira', { token: TOKEN, email: 'a@b.co' });
    config.saveConnectorFields('local', 'slack', { token: 'xoxp-1' });
    config.forgetConnector('local', 'jira');
    expect(tool.store.has('local:jira')).toBe(false);
    expect(tool.store.get('local:slack')).toBe('xoxp-1');
    expect(config.getConnectorFields('local', 'jira')).toBeNull();
    expect(fileTokens()['local:jira:field:email']).toBeUndefined();
  });

  it('forgetConnector also drops a plaintext copy left in the file', () => {
    const config = open();
    tool.breakIt();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    config.forgetConnector('local', 'github');
    expect(fileTokens()['local:github']).toBeUndefined();
  });

  it('forgetAllConnectors clears every keychain token of that environment and no other', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    config.saveConnectorFields('local', 'jira', { token: 'j' });
    config.setConnectorToken('prod', 'jira-personal', 'oauth');
    config.forgetAllConnectors('local');
    expect([...tool.store.keys()]).toEqual(['prod:jira-personal']);
  });

  it('forgetAllConnectors finds a keychain token even when the config file lost its record of it', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    disk.data['connectorTokens'] = {};
    disk.data['keychainTokens'] = [];
    config.forgetAllConnectors('local');
    expect(tool.store.size).toBe(0);
  });

  it('says so when the keychain could not remove the token', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    tool.breakIt('locked');
    expect(config.forgetConnector('local', 'github')).toEqual({ keychainFailed: true });
  });

  it('reports a clean removal as clean', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    expect(config.forgetConnector('local', 'github')).toEqual({ keychainFailed: false });
  });
});

describe('a token from an environment variable', () => {
  it('beats the keychain and the file', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: 'stored-in-keychain' });
    disk.data['connectorTokens'] = { ...fileTokens(), 'local:github': 'stored-in-file' };
    vi.stubEnv('ALIGN_GITHUB_TOKEN', 'from-the-environment');
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: 'from-the-environment' });
  });

  it('is ignored when unset, and the keychain answers', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: 'stored-in-keychain' });
    vi.stubEnv('ALIGN_GITHUB_TOKEN', undefined);
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: 'stored-in-keychain' });
  });

  it('an empty variable counts as unset', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: 'stored-in-keychain' });
    vi.stubEnv('ALIGN_GITHUB_TOKEN', '');
    expect(config.getConnectorFields('local', 'github')).toEqual({ token: 'stored-in-keychain' });
  });

  it('connects a source that has nothing saved', () => {
    vi.stubEnv('ALIGN_GITHUB_TOKEN', 'from-the-environment');
    expect(open().getConnectorFields('local', 'github')).toEqual({ token: 'from-the-environment' });
  });

  it('supplies the Atlassian email and domain too', () => {
    vi.stubEnv('ALIGN_JIRA_TOKEN', 'jt');
    vi.stubEnv('ALIGN_JIRA_EMAIL', 'me@x.co');
    vi.stubEnv('ALIGN_JIRA_DOMAIN', 'x.atlassian.net');
    expect(open().getConnectorFields('local', 'jira')).toEqual({ token: 'jt', email: 'me@x.co', domain: 'x.atlassian.net' });
  });

  it('is never written to disk or the keychain when setup saves what it read', () => {
    vi.stubEnv('ALIGN_JIRA_TOKEN', 'jt-from-env');
    vi.stubEnv('ALIGN_JIRA_EMAIL', 'me@x.co');
    const config = open();
    const fields = config.getConnectorFields('local', 'jira')!;
    config.saveConnectorFields('local', 'jira', fields);
    expect(JSON.stringify(disk.data)).not.toContain('jt-from-env');
    expect(JSON.stringify(disk.data)).not.toContain('me@x.co');
    expect(tool.store.size).toBe(0);
  });

  it('a pasted token that differs from the variable is saved normally', () => {
    vi.stubEnv('ALIGN_GITHUB_TOKEN', 'from-the-environment');
    const config = open();
    config.saveConnectorFields('local', 'github', { token: 'pasted' });
    expect(tool.store.get('local:github')).toBe('pasted');
  });

  it('does not apply to another environment', () => {
    vi.stubEnv('ALIGN_GITHUB_TOKEN', 'from-the-environment');
    expect(open().getConnectorFields('prod', 'github')).toBeNull();
  });
});

describe('which store is in use', () => {
  it('reports the keychain, and where each source token is', () => {
    const config = open();
    config.saveConnectorFields('local', 'github', { token: TOKEN });
    expect(config.tokenStoreStatus()).toMatchObject({ store: 'keychain' });
  });

  it('reports the file and why when there is no keychain', () => {
    tool.breakIt('no secret service');
    vault = createTokenVault({ selection: selectBackend({ platform: 'linux', run: tool.run }), notify: () => undefined });
    expect(open().tokenStoreStatus()).toMatchObject({ store: 'file', reason: expect.stringContaining('no secret service') });
  });
});
