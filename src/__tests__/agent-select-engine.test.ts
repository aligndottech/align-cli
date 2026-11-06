import { describe, expect, it } from 'vitest';
import { selectEngine } from '../lib/agent/select-engine.js';

describe('selectEngine: the default', () => {
  it('runs Align on a configured model', () => {
    expect(selectEngine({ hasModel: true, claudeOnPath: true })).toEqual({ engine: 'align' });
  });
  it('runs Align on a configured model even with no Claude Code installed', () => {
    expect(selectEngine({ hasModel: true, claudeOnPath: false })).toEqual({ engine: 'align' });
  });
  it('runs the user\'s own Claude Code when there is no model', () => {
    expect(selectEngine({ hasModel: false, claudeOnPath: true })).toEqual({ engine: 'claude-code' });
  });
  it('has nothing to run with no model and no Claude Code', () => {
    expect(selectEngine({ hasModel: false, claudeOnPath: false })).toEqual({ engine: 'none' });
  });
});

describe('selectEngine: --engine', () => {
  it('runs Claude Code when asked, even with a model configured', () => {
    expect(selectEngine({ flag: 'claude', hasModel: true, claudeOnPath: true })).toEqual({ engine: 'claude-code' });
  });
  it('runs Align when asked, even with Claude Code installed and no saved choice', () => {
    expect(selectEngine({ flag: 'align', hasModel: true, claudeOnPath: true, remembered: 'claude' })).toEqual({ engine: 'align' });
  });
  it('says why when the asked-for engine cannot run, rather than quietly switching', () => {
    expect(selectEngine({ flag: 'claude', hasModel: true, claudeOnPath: false })).toEqual({ engine: 'none', unavailable: 'claude' });
    expect(selectEngine({ flag: 'align', hasModel: false, claudeOnPath: true })).toEqual({ engine: 'none', unavailable: 'align' });
  });
});

describe('selectEngine: the remembered choice', () => {
  it('keeps the engine the user picked last time', () => {
    expect(selectEngine({ remembered: 'claude', hasModel: true, claudeOnPath: true })).toEqual({ engine: 'claude-code' });
  });
  it('falls back to the default when the remembered engine can no longer run', () => {
    expect(selectEngine({ remembered: 'claude', hasModel: true, claudeOnPath: false })).toEqual({ engine: 'align' });
  });
});
