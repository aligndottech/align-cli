import { describe, expect, it } from 'vitest';
import { answerForKey, createController } from '../lib/agent/tui/controller.js';

describe('controller: turns', () => {
  it('sends a submitted line once and ignores a second submit while the turn runs', () => {
    const c = createController();
    expect(c.submit('  fix the bug ')).toBe('fix the bug');
    expect(c.phase()).toBe('running');
    expect(c.submit('and another')).toBeUndefined();
    c.turnEnded();
    expect(c.phase()).toBe('idle');
    expect(c.submit('and another')).toBe('and another');
  });
  it('ignores an empty line and stays idle', () => {
    const c = createController();
    expect(c.submit('   ')).toBeUndefined();
    expect(c.phase()).toBe('idle');
  });
  it('escape aborts only while a turn runs', () => {
    const c = createController();
    expect(c.escape()).toBe('none');
    c.submit('go');
    expect(c.escape()).toBe('abort');
  });
  it('shows awaiting-answer during a question, then returns to running', () => {
    const c = createController();
    c.submit('go');
    c.beginAsk();
    expect(c.phase()).toBe('awaiting-answer');
    expect(c.escape()).toBe('none');
    c.endAsk();
    expect(c.phase()).toBe('running');
  });
});

describe('controller: leaving', () => {
  it('needs two Ctrl+C in a row', () => {
    const c = createController();
    expect(c.ctrlC()).toBe('hint');
    expect(c.ctrlC()).toBe('exit');
  });
  it('any other key between the two resets the count', () => {
    const c = createController();
    c.ctrlC();
    c.otherKey();
    expect(c.ctrlC()).toBe('hint');
  });
  it('Ctrl+D exits only on an empty editor', () => {
    const c = createController();
    expect(c.ctrlD(false)).toBe('none');
    expect(c.ctrlD(true)).toBe('exit');
  });
});

describe('answer keys', () => {
  it('maps the gate keys', () => {
    expect(answerForKey('gate', 'a')).toBe('allow');
    expect(answerForKey('gate', 's')).toBe('stop');
    expect(answerForKey('gate', 'y')).toBeUndefined();
    expect(answerForKey('gate', 'n')).toBeUndefined();
  });
  it('maps the command keys', () => {
    expect(answerForKey('command', 'y')).toBe('allow');
    expect(answerForKey('command', 's')).toBe('allow-session');
    expect(answerForKey('command', 'n')).toBe('stop');
    expect(answerForKey('command', 'a')).toBeUndefined();
  });
  it('ignores capitals the same as lower case', () => {
    expect(answerForKey('gate', 'S')).toBe('stop');
  });
});
