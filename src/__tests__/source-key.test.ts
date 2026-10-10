// L2: the identity of a connector item that is exactly one thing per URL. Two readers of one
// format must agree, so the SDK's published fixture table is run against the function the CLI
// uses. L3: that function is the SDK's own, re-exported, so there is no copy left to drift.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { normaliseSourceKey as sdkNormaliseSourceKey } from '@aligndottech/connector-core';
import { connectorItemKey, normaliseSourceKey } from '../lib/source-key.js';

interface KeyCase { platform: string; rule: string; a: string; b?: string; same?: boolean; key: string | null; why: string }

// L3: the table is read from the SDK package itself (its `./source-key-fixtures.json` export), and
// the function under test IS the SDK's. There is no local copy of either to drift from.
const TABLE = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('@aligndottech/connector-core/source-key-fixtures.json'), 'utf8'),
) as { cases: KeyCase[] };

describe('normaliseSourceKey is the SDK function, not a copy (L3)', () => {
  it('is the very same function the SDK exports', () => {
    expect(normaliseSourceKey).toBe(sdkNormaliseSourceKey);
  });

  it('has no second implementation file on disk: source-key.ts re-exports and carries no URL parsing', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'source-key.ts'), 'utf8');
    expect(src).toMatch(/export \{ normaliseSourceKey \} from '@aligndottech\/connector-core'/);
    expect(src).not.toMatch(/QUERY_ALLOWLIST|searchParams|new URL\(u/);
  });
});

describe('normaliseSourceKey: the SDK fixture table', () => {
  it('read the table (positive control: a path typo must not pass with zero rows)', () => {
    expect(TABLE.cases.length).toBeGreaterThan(100);
  });

  it.each(TABLE.cases.map(c => [`${c.platform}/${c.rule}: ${c.why}`, c] as const))('%s', (_name, c) => {
    expect(normaliseSourceKey(c.platform, c.a)).toBe(c.key ?? undefined);
    if (c.b !== undefined) {
      expect(normaliseSourceKey(c.platform, c.a) === normaliseSourceKey(c.platform, c.b)).toBe(c.same);
    }
  });

  it('a Notion database peek keys on the peeked page, never the database', () => {
    const db = '0123456789abcdef0123456789abcdef';
    const page = 'fedcba9876543210fedcba9876543210';
    expect(normaliseSourceKey('notion', `https://www.notion.so/acme/db${db.slice(2)}?v=1&p=${page}`)).toBe(`https://www.notion.so/${page}`);
  });
});

describe('connectorItemKey: local policy on top of the shared format', () => {
  it('namespaces the key by platform, so a git commit and a github row for the same URL never share one', () => {
    const u = 'https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567';
    expect(connectorItemKey('git', u)).toBe(`git|${u}`);
    expect(connectorItemKey('github', u)).toBe(`github|${u}`);
    expect(connectorItemKey('git', u)).not.toBe(connectorItemKey('github', u));
  });

  it.each([
    ['github', 'https://github.com/o/r/pull/12', 'github|https://github.com/o/r/pull/12'],
    ['github', 'https://github.com/O/R/pull/12#issuecomment-1', 'github|https://github.com/o/r/pull/12'],
    ['linear', 'https://linear.app/align/issue/ALI-1505/title-slug', 'linear|https://linear.app/align/issue/ALI-1505'],
    ['jira', 'https://x.atlassian.net/browse/ALI-12', 'jira|https://x.atlassian.net/browse/ALI-12'],
    ['confluence', 'https://x.atlassian.net/wiki/spaces/ENG/pages/123456/Title', 'confluence|https://x.atlassian.net/wiki/pages/123456'],
    ['slack', 'https://acme.slack.com/archives/C9/p1700000000123456', 'slack|https://slack.com/archives/C9/p1700000000123456'],
    ['git', 'git://commit/0123abc', 'git|git://commit/0123abc'],
  ])('%s %s', (platform, url, key) => {
    expect(connectorItemKey(platform, url)).toBe(key);
  });

  it.each([
    ['agent-session', 'https://github.com/o/r/pull/12'],
    ['cli', 'https://github.com/o/r/pull/12'],
    ['docs', 'https://github.com/o/r/blob/main/docs/adr/0001.md'],
    ['confluence', 'https://x.atlassian.net/wiki/spaces/ENG'],
    ['teams', 'https://teams.microsoft.com'],
    ['teams', 'https://teams.microsoft.com/l/channel/19:abc'],
    ['github', 'https://github.com/o/r/pulls'],
    ['slack', 'https://slack.com/archives/C0123'],
    ['jira', 'https://api.atlassian.com/ex/jira/cloud-id/browse/ALI-1'],
  ])('%s %s is not an item URL: no key', (platform, url) => {
    expect(connectorItemKey(platform, url)).toBeUndefined();
  });
});
