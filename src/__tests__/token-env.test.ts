import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSources } from '../commands/setup.js';
import { ENV_FIELDS, envCredentials, fieldEnvName, tokenEnvName } from '../lib/token-env.js';
import { KNOWN_SOURCES } from '../lib/sync/source-ids.js';

beforeEach(() => {
  for (const s of KNOWN_SOURCES) {
    vi.stubEnv(tokenEnvName(s), undefined);
    for (const f of ENV_FIELDS[s] ?? []) vi.stubEnv(fieldEnvName(s, f), undefined);
  }
});

describe('environment variable names', () => {
  it.each(KNOWN_SOURCES)('%s has ALIGN_<SOURCE>_TOKEN', (s) => {
    expect(tokenEnvName(s)).toBe(`ALIGN_${s.toUpperCase()}_TOKEN`);
  });
  it('names a field after its source', () => {
    expect(fieldEnvName('jira', 'email')).toBe('ALIGN_JIRA_EMAIL');
  });
});

describe('the extra-field table matches setup', () => {
  const sources = buildSources(true);
  it('names every extra field that any source asks for, and nothing setup does not ask for', () => {
    const asked = Object.fromEntries(sources.filter((s) => (s.extraFields?.length ?? 0) > 0).map((s) => [s.id, (s.extraFields ?? []).map((f) => f.key).sort()]));
    const table = Object.fromEntries(Object.entries(ENV_FIELDS).map(([k, v]) => [k, [...v].sort()]));
    expect(table).toEqual(asked);
  });
  it('every source setup can paste a token for is a known sync source', () => {
    for (const s of sources.filter((x) => x.tokenLabel)) expect(KNOWN_SOURCES).toContain(s.id);
  });
});

describe('envCredentials', () => {
  it('reads the token when set and nothing when unset', () => {
    expect(envCredentials('github', { ALIGN_GITHUB_TOKEN: 'abc' })).toEqual({ token: 'abc' });
    expect(envCredentials('github', {})).toBeNull();
  });
  it('treats an empty value as unset', () => {
    expect(envCredentials('github', { ALIGN_GITHUB_TOKEN: '' })).toBeNull();
  });
  it('ignores a field variable with no token', () => {
    expect(envCredentials('jira', { ALIGN_JIRA_EMAIL: 'a@b.co' })).toBeNull();
  });
  it('does not read another source', () => {
    expect(envCredentials('slack', { ALIGN_GITHUB_TOKEN: 'abc' })).toBeNull();
  });
});
