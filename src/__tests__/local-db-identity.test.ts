/**
 * A `source_url` is only an identity if it identifies ONE thing. Some fetchers emit a constant
 * when the per-item link is missing, and connector-core ships one:
 *
 *     dist/fetchers/teams.js:60   source_url: msg.webUrl ?? 'https://teams.microsoft.com'
 *
 * Confluence has the same shape - an absent `webui` leaves `pageUrl` equal to `linkBase`, one
 * value per run. Treating those as identities is destructive in both directions once
 * source_url is unique: a fresh import of three such messages collapses to one row holding the
 * last, and opening an existing graph DELETES the copies already stored. Measured both ways
 * before this guard existed.
 *
 * So identity is "a URL that points at a specific thing", and a bare origin does not. Such a
 * URL is still STORED - it is useful context, and `align search` shows it - it just does not
 * participate in dedup, exactly like the null it stands in for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb, identifyingSourceUrl } from '../lib/local-db.js';

describe('identifyingSourceUrl', () => {
  it.each([
    ['https://teams.microsoft.com', 'the connector-core Teams fallback'],
    ['https://teams.microsoft.com/', 'the same with a trailing slash'],
    ['', 'an empty string, which `?? null` does not catch'],
    ['   ', 'whitespace only'],
  ])('treats %j as NOT identifying (%s)', (url) => {
    expect(identifyingSourceUrl(url)).toBeNull();
  });

  /**
   * Deliberately NOT handled here: Confluence's `linkBase` fallback yields something like
   * `https://site.atlassian.net/wiki`, which has a path and is therefore indistinguishable from
   * a legitimately short page URL. Guessing at it would mean hardcoding a list of known
   * fallbacks, which is the enumerate-and-miss shape - the list is wrong the day a fetcher
   * invents a new one. That case is covered by the second half of the key instead: uniqueness is
   * on (source_url, title), so two different pages sharing a linkBase keep their own rows.
   */
  it('treats a bare-path URL as identifying, because it cannot be told from a real short URL', () => {
    expect(identifyingSourceUrl('https://example.atlassian.net/wiki')).toBe('https://example.atlassian.net/wiki');
  });

  it.each([
    ['git://commit/d0364cabfef7c371b0773c2d469c3ad1f304a1b2'],
    ['https://github.com/aligndottech/align-cli/pull/143'],
    ['https://teams.microsoft.com/l/message/19:abc/1699'],
    ['https://example.atlassian.net/wiki/spaces/ENG/pages/42/Decision'],
    ['https://linear.app/align/issue/ALI-1'],
  ])('treats %j as identifying', (url) => {
    expect(identifyingSourceUrl(url)).toBe(url);
  });

  it('passes null through', () => {
    expect(identifyingSourceUrl(null)).toBeNull();
  });

  // A non-URL string is still an identity: `git://commit/<sha>` is not http, and a future
  // fetcher may invent its own scheme. Only a parseable URL with no path is rejected.
  it('treats an unparseable string as identifying rather than discarding it', () => {
    expect(identifyingSourceUrl('some-opaque-key-123')).toBe('some-opaque-key-123');
  });
});

describe('a constant source_url does not collapse unrelated decisions', () => {
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-ident-${Date.now()}-${Math.trunc(performance.now())}.db`);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + s)) fs.unlinkSync(dbPath + s);
  });

  it('keeps three Teams messages that share the fallback URL', () => {
    db = createLocalDb(dbPath);
    const ids = ['first', 'second', 'third'].map(t =>
      db!.insertDecision({ title: t, summary: t, sourceUrl: 'https://teams.microsoft.com', platform: 'teams' }),
    );

    expect(db.listDecisions()).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // The non-identifying URL is normalised away rather than stored: it addresses a host and
    // nothing on it, so rendering it as this decision's "source" link would send a reader to a
    // homepage. One column, one meaning.
    expect(db.listDecisions().every(r => r.sourceUrl === null)).toBe(true);
  });

  // The other half of the key, which is what protects the fallbacks a URL check cannot see
  // (Confluence's linkBase). Same URL, different decisions, both kept.
  it('keeps two decisions that share a path-bearing URL but are different decisions', () => {
    db = createLocalDb(dbPath);
    const base = 'https://example.atlassian.net/wiki';
    const a = db.insertDecision({ title: 'Adopt pnpm', summary: 'a', sourceUrl: base, platform: 'confluence' });
    const b = db.insertDecision({ title: 'Use Postgres', summary: 'b', sourceUrl: base, platform: 'confluence' });

    expect(db.listDecisions()).toHaveLength(2);
    expect(a).not.toBe(b);
  });

  it('still refreshes when the URL AND the title both match', () => {
    db = createLocalDb(dbPath);
    const base = 'https://example.atlassian.net/wiki';
    const a = db.insertDecision({ title: 'Adopt pnpm', summary: 'first', sourceUrl: base, platform: 'confluence' });
    const b = db.insertDecision({ title: 'Adopt pnpm', summary: 'second', sourceUrl: base, platform: 'confluence' });

    expect(b).toBe(a);
    expect(db.listDecisions()[0]).toMatchObject({ summary: 'second' });
  });

  // The positive control: a URL that DOES identify one thing must still collapse, or the guard
  // above is just a blanket ban on dedup and the whole point of this change is gone. Same title
  // too, because the key is the pair - a re-import of one message supplies both again.
  it('still collapses a re-imported message with a real per-item URL', () => {
    db = createLocalDb(dbPath);
    const url = 'https://teams.microsoft.com/l/message/19:abc/1699';
    const a = db.insertDecision({ title: 'Ship on Friday', summary: 'first read', sourceUrl: url, platform: 'teams' });
    const b = db.insertDecision({ title: 'Ship on Friday', summary: 'second read', sourceUrl: url, platform: 'teams' });

    expect(db.listDecisions()).toHaveLength(1);
    expect(b).toBe(a);
    expect(db.listDecisions()[0]).toMatchObject({ summary: 'second read' });
  });
});
