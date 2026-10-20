import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - a plain .mjs script with no type declarations
import { leak, sharedRun } from '../../scripts/retrieval-eval-v2.mjs';

interface Item { repo: string; clone_sha: string; expected_sha: string; kind: string; question: string; subject: string; generator: string; date: string }
const read = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'scripts', f), 'utf8'));
const fixture: { generator: string; date: string; items: Item[] } = read('retrieval-eval-v2-questions.json');
const repos: Array<{ name: string; sha: string }> = read('retrieval-eval-repos.json');

describe('retrieval eval v2 leakage guard', () => {
  it('flags a question that shares four consecutive words with the subject', () => {
    expect(sharedRun('why do we drop support for node 14 now', 'Drop support for Node 14', 4)).toBe('drop support for node');
  });

  it('lets three shared words through, because a newcomer reuses ordinary words', () => {
    expect(sharedRun('why did we drop support for old versions', 'Drop support for Node 14', 4)).toBeNull();
  });

  it('ignores case and punctuation when it compares', () => {
    expect(sharedRun('Why was "find-my-way" REMOVED, again?', 'remove find my way from core', 3)).toBe('find my way');
  });

  it('leak() applies the four-word window: four shared words leak, three do not', () => {
    const sha = 'b'.repeat(40);
    expect(leak('why did we replace the legacy session cache layer', 'Replace the legacy session store', sha)).toBe('shares "replace the legacy session" with the subject');
    expect(leak('why did we replace the legacy cache', 'Replace the legacy session store', sha)).toBeNull();
  });

  it('flags a question that shares three stemmed content words with the subject, and allows two', () => {
    const sha = 'c'.repeat(40);
    expect(leak('why do routers expose http', 'add http verbs methods to Router', sha)).toBeNull();
    expect(leak('why do routers expose http verbs', 'add http verbs methods to Router', sha)).toMatch(/shares content words/);
  });

  it('flags a question that names the whole short subject', () => {
    expect(leak('what happened with drop xdg', 'drop xdg', 'a'.repeat(40))).toBe('contains the whole subject');
  });

  it('flags a question that carries the start of the sha, and passes a clean one', () => {
    const sha = '3931ccb0b8468842d0c7e9ea0fc2912d31dff9a2';
    expect(leak('why did 3931ccb change prompts', 'size prompts', sha)).toBe('contains the sha');
    expect(leak('why are prompts sized from the real window', 'size prompts to the context window', sha)).toBeNull();
  });
});

describe('retrieval eval v2 frozen questions', () => {
  it('has enough questions across all pinned repos to be read per repo', () => {
    expect(fixture.items.length).toBeGreaterThanOrEqual(150);
    expect(fixture.items.length).toBeLessThanOrEqual(300);
    expect(new Set(fixture.items.map(i => i.repo))).toEqual(new Set(repos.map(r => r.name)));
  });

  it('records the generator and date on every question', () => {
    for (const i of fixture.items) {
      expect(i.generator, i.question).toBeTruthy();
      expect(i.date, i.question).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('pins each question to the clone sha the repos file records', () => {
    const shaOf = Object.fromEntries(repos.map(r => [r.name, r.sha]));
    for (const i of fixture.items) expect(i.clone_sha, i.repo).toBe(shaOf[i.repo]);
  });

  it('has no question that leaks its answer', () => {
    const leaks = fixture.items.map(i => ({ q: i.question, why: leak(i.question, i.subject, i.expected_sha) })).filter(x => x.why);
    expect(leaks).toEqual([]);
  });

  it('has no duplicate question, so each has one right answer', () => {
    const qs = fixture.items.map(i => i.question.toLowerCase());
    expect(new Set(qs).size).toBe(qs.length);
  });

  it('asks both kinds of question, a concept and a symptom', () => {
    expect(new Set(fixture.items.map(i => i.kind))).toEqual(new Set(['concept', 'symptom']));
  });
});
