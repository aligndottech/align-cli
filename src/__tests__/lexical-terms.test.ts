import { describe, expect, it } from 'vitest';
import { queryTerms, stem, termCounts, TITLE_TERM_WEIGHT, tokenize } from '../lib/lexical-terms.js';

describe('stem: one stemmer for the index and the query', () => {
  it.each([
    ['process', 'processes'],
    ['remove', 'removed'],
    ['remove', 'removes'],
    ['remove', 'removing'],
    ['query', 'queries'],
    ['cache', 'caches'],
    ['drop', 'dropped'],
    ['drop', 'dropping'],
    ['run', 'running'],
  ])('%s and %s meet', (a, b) => {
    expect(stem(a)).toBe(stem(b));
  });

  it('keeps words that only look like plurals', () => {
    expect(stem('status')).toBe('status');
    expect(stem('analysis')).toBe('analysis');
    expect(stem('class')).toBe('class');
  });

  it('leaves short words alone and does not strip a word to nothing', () => {
    expect(stem('use')).toBe('use');
    expect(stem('is')).toBe('is');
    expect(stem('ing')).toBe('ing');
  });

  it('a plural question word finds a singular title word through the tokenizer', () => {
    expect(tokenize('why were the processes dropped')).toEqual(expect.arrayContaining(tokenize('process drop')));
  });
});

describe('tokenize', () => {
  it('keeps a kebab identifier whole and in parts', () => {
    expect(tokenize('switch to find-my-way')).toEqual(expect.arrayContaining(['find-my-way', 'find', 'way']));
  });
  it('splits camelCase and keeps the compound', () => {
    expect(tokenize('getUserName')).toEqual(expect.arrayContaining(['getusername', 'user', 'name']));
  });
  it('splits snake_case and paths', () => {
    expect(tokenize('lib/content_type_parser.js')).toEqual(expect.arrayContaining(['lib/content_type_parser.js', 'content', 'type', 'parser']));
  });
  it('splits letters from digits: node18 and pino', () => {
    expect(tokenize('node18')).toEqual(expect.arrayContaining(['node18', 'node', '18']));
    expect(tokenize('bump pino')).toContain('pino');
  });
  it('does not count a plain word twice', () => {
    expect(tokenize('router').filter(t => t === 'router')).toHaveLength(1);
  });
  it('drops scaffolding words', () => {
    expect(tokenize('why was it removed')).toEqual(['remov']);
  });
});

describe('termCounts and queryTerms', () => {
  it('counts a title term TITLE_TERM_WEIGHT times and a body term once', () => {
    const c = termCounts('zorblax', 'zorblax quux');
    expect(c.get('zorblax')).toBe(TITLE_TERM_WEIGHT + 1);
    expect(c.get('quux')).toBe(1);
  });
  it('gives each distinct query term weight one', () => {
    expect([...queryTerms('pino pino logger')]).toEqual([['pino', 1], ['logger', 1]]);
  });
});
