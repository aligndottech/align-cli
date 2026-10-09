// L2: the identity of a connector item that is exactly one thing per URL (a PR, an issue, a
// page, a thread, a meeting, a commit). Two rows with the same key are the same item under an
// edited title, which the (source_url, title) key cannot see.
//
// Until connector-core 0.10.0 publishes the shared normaliser and its fixture table (S1), this
// is the local copy, and these rows are its fixture table. Two cases per rule, on both sides.

import { describe, expect, it } from 'vitest';
import { normaliseSourceKey } from '../lib/source-key.js';

describe('normaliseSourceKey: one key per item URL', () => {
  it.each([
    // [platform, url, expected key]
    ['github', 'https://github.com/o/r/pull/12', 'https://github.com/o/r/pull/12'],
    ['github', 'https://github.com/o/r/issues/7', 'https://github.com/o/r/issues/7'],
    ['gitlab', 'https://gitlab.com/g/p/-/merge_requests/3', 'https://gitlab.com/g/p/-/merge_requests/3'],
    ['gitlab', 'https://gitlab.example.com/g/sub/p/-/issues/9', 'https://gitlab.example.com/g/sub/p/-/issues/9'],
    ['jira', 'https://x.atlassian.net/browse/ALI-12', 'https://x.atlassian.net/browse/ALI-12'],
    ['jira', 'https://jira.corp.example/browse/OPS-1', 'https://jira.corp.example/browse/OPS-1'],
    ['linear', 'https://linear.app/align/issue/ALI-1505/title-slug', 'https://linear.app/align/issue/ALI-1505/title-slug'],
    ['linear', 'https://linear.app/team/issue/ENG-7', 'https://linear.app/team/issue/ENG-7'],
    ['confluence', 'https://x.atlassian.net/wiki/spaces/ENG/pages/123456/Title', 'https://x.atlassian.net/wiki/spaces/ENG/pages/123456/Title'],
    ['confluence', 'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=99&foo=1', 'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=99'],
    ['notion', 'https://www.notion.so/Design-doc-0123456789abcdef0123456789abcdef', 'https://www.notion.so/Design-doc-0123456789abcdef0123456789abcdef'],
    ['notion', 'https://www.notion.so/ws/0123456789abcdef0123456789abcdef', 'https://www.notion.so/ws/0123456789abcdef0123456789abcdef'],
    ['slack', 'https://slack.com/archives/C0123/p1700000000123456', 'https://slack.com/archives/C0123/p1700000000123456'],
    ['slack', 'https://acme.slack.com/archives/C9/p1?thread_ts=1.2&cid=C9', 'https://acme.slack.com/archives/C9/p1?thread_ts=1.2'],
    ['teams', 'https://teams.microsoft.com/l/message/19:abc@thread.tacv2/1616965872395?groupId=g', 'https://teams.microsoft.com/l/message/19:abc@thread.tacv2/1616965872395'],
    ['teams', 'https://teams.microsoft.com/l/message/19:def@thread.skype/42', 'https://teams.microsoft.com/l/message/19:def@thread.skype/42'],
    ['zoom', 'https://zoom.us/recording/abc%2F%2Bdef', 'https://zoom.us/recording/abc%2F%2Bdef'],
    ['zoom', 'https://zoom.us/recording/xyz==', 'https://zoom.us/recording/xyz=='],
    ['git', 'https://github.com/o/r/commit/0123abc', 'https://github.com/o/r/commit/0123abc'],
    ['git', 'git://commit/0123abc', 'git://commit/0123abc'],
  ])('%s %s', (platform, url, key) => {
    expect(normaliseSourceKey(platform, url)).toBe(key);
  });

  it('lowercases the scheme and host, never the path', () => {
    expect(normaliseSourceKey('github', 'HTTPS://GitHub.com/O/R/pull/12')).toBe('https://github.com/O/R/pull/12');
    expect(normaliseSourceKey('jira', 'https://X.Atlassian.NET/browse/ALI-1')).toBe('https://x.atlassian.net/browse/ALI-1');
  });

  it('drops a trailing slash and a fragment', () => {
    expect(normaliseSourceKey('github', 'https://github.com/o/r/pull/12/')).toBe('https://github.com/o/r/pull/12');
    expect(normaliseSourceKey('github', 'https://github.com/o/r/pull/12#issuecomment-1')).toBe('https://github.com/o/r/pull/12');
  });

  it('drops the query unless the platform needs a parameter of it', () => {
    expect(normaliseSourceKey('github', 'https://github.com/o/r/issues/7?utm=x')).toBe('https://github.com/o/r/issues/7');
    expect(normaliseSourceKey('jira', 'https://x.atlassian.net/browse/ALI-1?focusedCommentId=3')).toBe('https://x.atlassian.net/browse/ALI-1');
  });
});

describe('normaliseSourceKey: no key where the URL may hold more than one decision', () => {
  it.each([
    // Sessions and manual captures hold several decisions under one transcript URL.
    ['agent-session', 'https://github.com/o/r/pull/12'],
    ['cli', 'https://github.com/o/r/pull/12'],
    // A docs file holds several sections.
    ['docs', 'https://github.com/o/r/blob/main/docs/adr/0001.md'],
    ['code', 'https://github.com/o/r/pull/12'],
  ])('platform %s', (platform, url) => {
    expect(normaliseSourceKey(platform, url)).toBeUndefined();
  });

  it.each([
    // A fetcher fallback that names a site, not an item: keying on it would merge every
    // item that fell back into one row.
    ['confluence', 'https://x.atlassian.net/wiki'],
    ['confluence', 'https://x.atlassian.net/wiki/spaces/ENG'],
    ['teams', 'https://teams.microsoft.com'],
    ['teams', 'https://teams.microsoft.com/l/channel/19:abc'],
    ['github', 'https://github.com/o/r'],
    ['github', 'https://github.com/o/r/pulls'],
    ['jira', 'https://x.atlassian.net/browse/'],
    ['slack', 'https://slack.com/archives/C0123'],
    ['notion', 'https://www.notion.so/'],
    ['linear', 'https://linear.app/align'],
    ['zoom', 'https://zoom.us/'],
    ['git', 'https://github.com/o/r'],
  ])('%s %s is not an item URL', (platform, url) => {
    expect(normaliseSourceKey(platform, url)).toBeUndefined();
  });

  it('returns undefined for a missing or unparseable URL', () => {
    expect(normaliseSourceKey('github', null)).toBeUndefined();
    expect(normaliseSourceKey('github', '')).toBeUndefined();
    expect(normaliseSourceKey('github', 'not a url')).toBeUndefined();
  });
});
