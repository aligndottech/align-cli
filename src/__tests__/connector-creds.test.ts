import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createConfigStore } from '../lib/config.js';

// The real Conf writes to the user's home directory. This double keeps the data in memory
// and, unlike the double in config.test.ts, RECORDS the constructor options - the file mode
// is one of them, and a credential file's permissions are part of what this suite pins.
const constructorOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      constructor(opts: Record<string, unknown>) {
        constructorOptions.push(opts);
        store = { ...((opts['defaults'] as Record<string, unknown>) ?? {}) };
      }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      clear() { store = {}; }
    },
  };
});

describe('local connector credentials', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
  });

  it('round-trips a token and its extra fields', () => {
    const config = createConfigStore();
    config.saveConnectorFields('local', 'jira', {
      token: 'atlassian-api-token',
      email: 'dev@example.com',
      domain: 'example.atlassian.net',
    });

    expect(config.getConnectorFields('local', 'jira')).toEqual({
      token: 'atlassian-api-token',
      email: 'dev@example.com',
      domain: 'example.atlassian.net',
    });
  });

  it('returns null for a connector that was never saved', () => {
    expect(createConfigStore().getConnectorFields('local', 'gitlab')).toBeNull();
  });

  // A saved connector must be distinguishable from an unsaved one even when it has no extra
  // fields, or GitHub (token only) reads as "never connected" and gets re-asked forever -
  // which is the whole defect this change exists to fix.
  it('reports a token-only connector as saved', () => {
    const config = createConfigStore();
    config.saveConnectorFields('local', 'github', { token: 'ghp_readonly' });

    expect(config.getConnectorFields('local', 'github')).toEqual({ token: 'ghp_readonly' });
  });

  // The OAuth path writes cloudId and siteBase under sibling keys in the same store. An extra
  // field that happens to share one of those names must not overwrite them, and vice versa.
  it('keeps extra fields clear of the OAuth-written cloudId and siteBase', () => {
    const config = createConfigStore();
    config.setConnectorCloudId('local', 'jira', 'oauth-cloud-id');
    config.setConnectorSiteBase('local', 'jira', 'https://oauth.atlassian.net');
    config.saveConnectorFields('local', 'jira', { token: 't', cloudId: 'a-field-not-the-oauth-one' });

    expect(config.getConnectorCloudId('local', 'jira')).toBe('oauth-cloud-id');
    expect(config.getConnectorSiteBase('local', 'jira')).toBe('https://oauth.atlassian.net');
    expect(config.getConnectorFields('local', 'jira')).toEqual({
      token: 't',
      cloudId: 'a-field-not-the-oauth-one',
    });
  });

  it('forgets a connector completely, extra fields included', () => {
    const config = createConfigStore();
    config.saveConnectorFields('local', 'jira', { token: 't', email: 'dev@example.com' });

    config.forgetConnector('local', 'jira');

    expect(config.getConnectorFields('local', 'jira')).toBeNull();
    expect(config.getConnectorToken('local', 'jira')).toBeNull();
  });

  // The negative half of the rule above: prove the delete is aimed. Asserting only that jira
  // is gone passes just as well when the implementation wipes the whole store.
  it('leaves other connectors alone when one is forgotten', () => {
    const config = createConfigStore();
    config.saveConnectorFields('local', 'jira', { token: 'jira-token', email: 'dev@example.com' });
    config.saveConnectorFields('local', 'github', { token: 'github-token' });

    config.forgetConnector('local', 'jira');

    expect(config.getConnectorFields('local', 'github')).toEqual({ token: 'github-token' });
  });

  it('scopes credentials by environment', () => {
    const config = createConfigStore();
    config.saveConnectorFields('local', 'github', { token: 'local-token' });
    config.saveConnectorFields('prod', 'github', { token: 'prod-token' });

    config.forgetConnector('local', 'github');

    expect(config.getConnectorFields('prod', 'github')).toEqual({ token: 'prod-token' });
  });

  // A stored empty token is a state nothing can use: setup treats it as unsaved (the reuse check
  // is truthy), while getConnectorFields reports the connector as saved and `local forget` claims
  // to remove something real. Refuse it at the writer rather than leaving the readers to disagree.
  it('refuses to save a connector with no token', () => {
    const config = createConfigStore();

    expect(() => config.saveConnectorFields('local', 'github', { token: '' })).toThrow(/token/i);
    expect(() => config.saveConnectorFields('local', 'github', {} as Record<string, string>)).toThrow(/token/i);
    expect(config.getConnectorFields('local', 'github')).toBeNull();
  });

  it('forgets every connector in one environment, leaving the others', () => {
    const config = createConfigStore();
    config.saveConnectorFields('local', 'jira', { token: 'jira-token', email: 'dev@example.com' });
    config.saveConnectorFields('local', 'github', { token: 'github-token' });
    config.saveConnectorFields('prod', 'github', { token: 'prod-token' });

    config.forgetAllConnectors('local');

    expect(config.getConnectorFields('local', 'jira')).toBeNull();
    expect(config.getConnectorFields('local', 'github')).toBeNull();
    expect(config.getConnectorFields('prod', 'github')).toEqual({ token: 'prod-token' });
  });

  // The config file holds read-only PATs once this change lands, so it stops being ordinary
  // config and becomes a credential file. 0600 is the claim the setup copy makes to the user.
  it('creates the config file readable only by its owner', () => {
    createConfigStore();

    expect(constructorOptions[0]?.['configFileMode']).toBe(0o600);
  });

  // Bug found live 2026-09-02: `conf`'s own default is `projectSuffix: 'nodejs'`
  // (node_modules/conf/dist/source/index.js), so without disabling it every real
  // install writes to `~/.config/align-cli-nodejs`, not the `~/.config/align-cli`
  // every comment and doc in this repo already claimed - including local-mode.ts's
  // own hand-written directory for the local graph DB, which lives in a DIFFERENT
  // directory as a result. `rm -rf ~/.config/align-cli` (the documented reset
  // instruction) silently did nothing to the saved tokens/telemetry-consent/auth
  // config, which is why a wiped local DB still reported "Signed in prod".
  it('disables the projectSuffix conf would otherwise add', () => {
    createConfigStore();

    expect(constructorOptions[0]?.['projectSuffix']).toBe('');
  });

  // Copilot review on #231: migrateConfigDirectory used to run automatically inside
  // createConfigStore(), so every test in this file - `conf` is mocked here, `fs` is
  // not - was hitting the REAL filesystem as a side effect of merely constructing a
  // store, on whatever machine happened to run the suite. Proves the fix directly:
  // construction alone must never touch disk, real fs and all.
  it('touches no filesystem migration path merely by being constructed', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    createConfigStore();

    expect(existsSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    existsSpy.mockRestore();
    copySpy.mockRestore();
  });
});
