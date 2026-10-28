import { describe, expect, it } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';

const SHA = '9e9f61a6bf092bbd3cf8d10b792432aa8be085af';
const OTHER = '4d870895b4c732718119b278648e48ce01b5e23b';

function seeded() {
  const db = createLocalDb(':memory:');
  const add = (title: string, sourceUrl: string, platform: string): string => db.insertDecision({ title, summary: 's', sourceUrl, platform });
  return {
    db,
    commit: add('clamp status', `https://github.com/fastify/fastify/commit/${SHA}`, 'git'),
    other: add('accept-version', `https://github.com/fastify/fastify/commit/${OTHER}`, 'git'),
    pr: add('PR 7000 title', 'https://github.com/Fastify/Fastify/pull/7000', 'github'),
    foreignPr: add('same number, other repo', 'https://github.com/acme/widgets/pull/7000', 'github'),
  };
}

describe('findBySourceRefs', () => {
  it('finds the decision stored under a commit url by its full sha, and only that one', () => {
    const s = seeded();
    expect(s.db.findBySourceRefs([SHA], []).map((r) => r.id)).toEqual([s.commit]);
  });

  it('finds a PR decision by url, ignoring case, and does not cross repos with the same PR number', () => {
    const s = seeded();
    expect(s.db.findBySourceRefs([], ['https://github.com/fastify/fastify/pull/7000']).map((r) => r.id)).toEqual([s.pr]);
  });

  it('returns each decision once when a sha and a PR url name the same row, and nothing for an unknown sha', () => {
    const s = seeded();
    const both = s.db.findBySourceRefs([SHA, SHA], ['https://github.com/fastify/fastify/pull/7000']);
    expect(both.map((r) => r.id).sort()).toEqual([s.commit, s.pr].sort());
    expect(s.db.findBySourceRefs(['a'.repeat(40)], [])).toEqual([]);
    expect(s.db.findBySourceRefs([], [])).toEqual([]);
  });
});
