import { describe, expect, it } from 'vitest';
import { formatElapsed, statusMessage, THINKING_WORDS, toolActivity, WORD_PERIOD_MS, wordAt } from '../lib/agent/tui/status.js';

describe('the status line words', () => {
  it('holds a word for one period, then moves to the next', () => {
    expect(wordAt(0, 0)).toBe(THINKING_WORDS[0]);
    expect(wordAt(0, WORD_PERIOD_MS - 1)).toBe(THINKING_WORDS[0]);
    expect(wordAt(0, WORD_PERIOD_MS)).toBe(THINKING_WORDS[1]);
    expect(wordAt(0, 2 * WORD_PERIOD_MS)).toBe(THINKING_WORDS[2]);
  });
  it('starts from the seed, so turns differ, and wraps round the list', () => {
    expect(wordAt(5, 0)).toBe(THINKING_WORDS[5]);
    expect(wordAt(THINKING_WORDS.length - 1, WORD_PERIOD_MS)).toBe(THINKING_WORDS[0]);
    expect(wordAt(-1, 0)).toBe(THINKING_WORDS[THINKING_WORDS.length - 1]);
  });
});

describe('elapsed time', () => {
  it.each([[0, '0s'], [999, '0s'], [12_400, '12s'], [59_999, '59s'], [60_000, '1m 00s'], [65_000, '1m 05s'], [3_725_000, '62m 05s']])('%i ms reads %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
  it('puts the word, the time and how to stop on one line', () => {
    expect(statusMessage({ word: 'Pondering', elapsedMs: 12_000 })).toBe('Pondering… (12s · esc to interrupt)');
  });
});

describe('what a running tool is doing', () => {
  it.each([
    ['align_ask', 'Asking the decision graph'],
    ['mcp__align__align_ask', 'Asking the decision graph'],
    ['mcp__align__align_search', 'Asking the decision graph'],
    ['align_check_alignment', 'Checking against your decisions'],
    ['mcp__align__align_get_related_decisions', 'Reading the decision graph'],
    ['Bash', 'Running a command'], ['bash', 'Running a command'],
    ['Read', 'Reading'], ['read', 'Reading'],
    ['Edit', 'Editing'], ['Write', 'Editing'], ['MultiEdit', 'Editing'],
    ['Grep', 'Searching'], ['Glob', 'Searching'], ['find', 'Searching'], ['ls', 'Searching'],
    ['WebFetch', 'Reading the web'], ['WebSearch', 'Reading the web'],
  ])('%s: %s', (tool, words) => {
    expect(toolActivity(tool)).toBe(words);
  });
  it('an unknown tool keeps the rotating word', () => {
    expect(toolActivity('mcp__other__do_thing')).toBeUndefined();
  });
});
