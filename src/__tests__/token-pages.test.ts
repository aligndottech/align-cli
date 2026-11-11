import { describe, expect, it } from 'vitest';
import { buildSources } from '../commands/setup.js';

/**
 * The pre-filled token pages. Each parameter below is one the vendor documents; the sources are listed in docs/importing.md.
 * A source with no documented parameter is pinned to a bare URL, so a guessed parameter goes red here instead of shipping.
 */
const sources = buildSources(true);
const urlOf = (id: string, tokens: Record<string, string> = {}): URL => {
  const s = sources.find((x) => x.id === id)!;
  const u = typeof s.tokenUrl === 'function' ? s.tokenUrl(tokens) : s.tokenUrl!;
  return new URL(u);
};

describe('read-only by construction', () => {
  it('GitHub pre-fills only read permissions and a 90 day expiry', () => {
    const q = urlOf('github').searchParams;
    expect(Number(q.get('expires_in'))).toBe(90);
    for (const k of ['contents', 'issues', 'pull_requests']) expect(q.get(k)).toBe('read');
    expect(urlOf('github').search).not.toMatch(/=(write|admin)/);
  });

  it('Slack opens "create app from manifest" with read-only user scopes and no bot user', () => {
    const u = urlOf('slack');
    expect(u.origin + u.pathname).toBe('https://api.slack.com/apps');
    expect(u.searchParams.get('new_app')).toBe('1');
    const manifest = JSON.parse(u.searchParams.get('manifest_json')!) as {
      display_information: { name: string };
      oauth_config: { scopes: { user: string[]; bot?: string[] } };
      features?: { bot_user?: unknown };
    };
    expect(manifest.display_information.name).toContain('Align');
    expect([...manifest.oauth_config.scopes.user].sort()).toEqual(['channels:history', 'channels:read', 'groups:history', 'groups:read']);
    expect(manifest.oauth_config.scopes.bot).toBeUndefined();
    expect(manifest.features?.bot_user).toBeUndefined();
  });

  it('Slack scopes in the URL are the ones the hint tells the person to expect', () => {
    const hint = sources.find((x) => x.id === 'slack')!.tokenHint!;
    const u = urlOf('slack');
    const scopes = (JSON.parse(u.searchParams.get('manifest_json')!) as { oauth_config: { scopes: { user: string[] } } }).oauth_config.scopes.user;
    for (const s of scopes) expect(hint).toContain(s);
  });

  it('GitLab pre-fills read_api and has no expiry parameter to set (none is documented)', () => {
    const q = urlOf('gitlab').searchParams;
    expect(q.get('scopes')).toBe('read_api');
    expect(q.has('expires_at')).toBe(false);
  });

  it.each(['jira', 'confluence', 'linear', 'notion', 'teams'])('%s uses the bare page: the vendor documents no pre-fill parameter', (id) => {
    expect(urlOf(id).search).toBe('');
  });
});
