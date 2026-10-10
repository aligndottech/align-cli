import { describe, expect, it } from 'vitest';
import {
  describeScopeKey, discloseTeamScope, disclosureText, fetchOptsFor, FIXED_SCOPES, labelOfScopeKey, normaliseScopeValues, SCOPED_SOURCES, scopeKeyOf, scopeLabel, ScopeValueError,
} from '../lib/scope-values.js';

/**
 * L4 Test List (the values a scope is made of):
 * - Each source accepts only its own non-secret syntax: a GitHub owner/repo, Jira project keys, Linear team keys or ids, a GitLab
 *   project id or path, Confluence space keys. Two examples that pass and two that fail, per source.
 * - A refused value is never echoed: a token pasted into the wrong field must not ride into an error transcript.
 * - The scope key is canonical (sorted, deduplicated, case-normalised), so the same choice made twice is one source_sync row.
 * - GitHub's key keeps the shape L5 already writes (`repo:o/r`), and "yours" stays `yours`.
 * - The disclosure says what team reads, that it stays on this machine, and the command that changes it.
 * - Sources with no named scope (Slack, Notion, Teams, Zoom) have a fixed, honest description; Zoom says it is only yours and why.
 */
describe('normaliseScopeValues', () => {
  it('github: owner/repo only, one value', () => {
    expect(normaliseScopeValues('github', 'aligndottech/align-stack')).toEqual(['aligndottech/align-stack']);
    expect(normaliseScopeValues('github', ['o/r.js'])).toEqual(['o/r.js']);
    expect(() => normaliseScopeValues('github', 'justonename')).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('github', 'https://github.com/o/r')).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('github', ['a/b', 'c/d'])).toThrow(/one repo/);
  });

  it('jira: capital-letter project keys, case-normalised, sorted, deduplicated', () => {
    expect(normaliseScopeValues('jira', ['ops', 'ALI', 'OPS'])).toEqual(['ALI', 'OPS']);
    expect(normaliseScopeValues('jira', 'ALI,OPS')).toEqual(['ALI', 'OPS']);
    expect(() => normaliseScopeValues('jira', ['A'])).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('jira', ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'])).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('jira', [])).toThrow(/at least one/);
  });

  it('jira: at most 20 projects', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `PA${String.fromCharCode(65 + i)}`);
    expect(normaliseScopeValues('jira', twenty)).toHaveLength(20);
    expect(() => normaliseScopeValues('jira', [...twenty, 'PZZ'])).toThrow(/at most 20/);
  });

  it('linear: team keys (capitalised) or team ids', () => {
    expect(normaliseScopeValues('linear', ['eng', 'PLAT'])).toEqual(['ENG', 'PLAT']);
    const id = '3f2b8c1e-5a4d-4e1b-9c7a-0d6e2f1a8b90';
    expect(normaliseScopeValues('linear', [id.toUpperCase()])).toEqual([id]);
    expect(() => normaliseScopeValues('linear', ['lin_api_0123456789abcdef0123456789abcdef'])).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('linear', ['E-N-G'])).toThrow(ScopeValueError);
  });

  it('gitlab: a numeric project id or a group/project path, one value', () => {
    expect(normaliseScopeValues('gitlab', '12345')).toEqual(['12345']);
    expect(normaliseScopeValues('gitlab', 'group/sub/project')).toEqual(['group/sub/project']);
    expect(() => normaliseScopeValues('gitlab', 'project')).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('gitlab', 'g/p?x=1')).toThrow(ScopeValueError);
  });

  it('confluence: space keys, personal spaces start with ~, 32 characters at most', () => {
    expect(normaliseScopeValues('confluence', ['OPS', 'ENG', 'OPS'])).toEqual(['ENG', 'OPS']);
    expect(normaliseScopeValues('confluence', ['~712020abc'])).toEqual(['~712020abc']);
    expect(() => normaliseScopeValues('confluence', ['has/slash'])).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('confluence', ['X'.repeat(33)])).toThrow(ScopeValueError);
  });

  it('a refused value is never echoed back, whichever source (two examples)', () => {
    const secret = 'ghp_SECRETVALUE0123456789abcdefABCDEF';
    for (const source of SCOPED_SOURCES) {
      let message = '';
      try { normaliseScopeValues(source, [secret]); } catch (e) { message = (e as Error).message; }
      expect(message, source).not.toBe('');
      expect(message, source).not.toContain('SECRETVALUE');
      expect(message, source).not.toContain('ghp_');
    }
    let longOne = '';
    try { normaliseScopeValues('jira', 'sk-ant-api03-SECRETVALUE'); } catch (e) { longOne = (e as Error).message; }
    expect(longOne).not.toContain('SECRETVALUE');
  });

  it('a value that is not text is refused without being printed', () => {
    expect(() => normaliseScopeValues('jira', [{ k: 'v' } as unknown as string])).toThrow(ScopeValueError);
    expect(() => normaliseScopeValues('jira', 5 as unknown as string)).toThrow(ScopeValueError);
  });
});

describe('scopeKeyOf and scopeLabel', () => {
  it('keeps the key L5 already writes for GitHub, and namespaces the others', () => {
    expect(scopeKeyOf('github', ['o/r'])).toBe('repo:o/r');
    expect(scopeKeyOf('jira', ['OPS', 'ALI'])).toBe('jira:ALI,OPS');
    expect(scopeKeyOf('linear', ['ENG'])).toBe('linear:ENG');
    expect(scopeKeyOf('gitlab', ['g/p'])).toBe('gitlab:g/p');
    expect(scopeKeyOf('confluence', ['OPS', 'ENG'])).toBe('confluence:ENG,OPS');
  });

  it('the same choice in a different order or case is the same key', () => {
    expect(scopeKeyOf('jira', normaliseScopeValues('jira', ['ops', 'ali']))).toBe(scopeKeyOf('jira', normaliseScopeValues('jira', ['ALI', 'OPS'])));
  });

  it('labels read as words', () => {
    expect(scopeLabel('github', ['o/r'])).toBe('o/r');
    expect(scopeLabel('jira', ['ALI', 'OPS'])).toBe('Jira projects ALI, OPS');
    expect(scopeLabel('jira', ['ALI'])).toBe('Jira project ALI');
    expect(scopeLabel('linear', ['ENG'])).toBe('Linear team ENG');
    expect(scopeLabel('gitlab', ['g/p'])).toBe('the GitLab project g/p');
    expect(scopeLabel('confluence', ['ENG', 'OPS'])).toBe('Confluence spaces ENG, OPS');
  });

  it('labelOfScopeKey is the place alone, and an unknown shape is returned as it is', () => {
    expect(labelOfScopeKey('github', 'repo:o/r')).toBe('o/r');
    expect(labelOfScopeKey('confluence', 'confluence:ENG')).toBe('Confluence space ENG');
    expect(labelOfScopeKey('jira', 'mystery:x')).toBe('mystery:x');
    expect(labelOfScopeKey('jira', 'jira:')).toBe('jira:');
  });

  it('describeScopeKey turns a stored key back into words, and falls back to the key for an unknown shape', () => {
    expect(describeScopeKey('github', 'repo:o/r', 'team')).toBe("everyone's items in o/r");
    expect(describeScopeKey('jira', 'jira:ALI,OPS', 'team')).toBe("everyone's items in Jira projects ALI, OPS");
    expect(describeScopeKey('jira', 'yours', 'yours')).toBe('your own items');
    expect(describeScopeKey('jira', 'mystery:x', 'team')).toBe("everyone's items in mystery:x");
  });
});

describe('fetchOptsFor', () => {
  it('maps a stored choice to the option each fetcher takes', () => {
    expect(fetchOptsFor('jira', ['ALI', 'OPS'])).toEqual({ projects: ['ALI', 'OPS'] });
    expect(fetchOptsFor('linear', ['id1'])).toEqual({ teams: ['id1'] });
    expect(fetchOptsFor('gitlab', ['g/p'])).toEqual({ projectId: 'g/p' });
    expect(fetchOptsFor('confluence', ['ENG'])).toEqual({ spaces: ['ENG'] });
    expect(fetchOptsFor('github', ['o/r'])).toEqual({});
  });
});

describe('disclosureText', () => {
  it('says what team reads, that it stays on this machine, and how to change it (two sources)', () => {
    const gh = disclosureText('github', ['aligndottech/align-stack']);
    expect(gh).toContain('Importing items from everyone in aligndottech/align-stack that your token can read.');
    expect(gh).toContain('They stay on this machine.');
    expect(gh).toContain('align connect --source github --scope yours');
    const jira = disclosureText('jira', ['ALI', 'OPS']);
    expect(jira).toContain('everyone in Jira projects ALI, OPS');
    expect(jira).toContain('align connect --source jira --scope yours');
  });

  it('is one line, with no em dash', () => {
    for (const s of SCOPED_SOURCES) {
      const t = disclosureText(s, ['X/Y']);
      expect(t).not.toContain('\n');
      expect(t).not.toContain('—');
    }
  });
});

describe('FIXED_SCOPES', () => {
  it('Zoom is only yours and says why in plain words', () => {
    expect(FIXED_SCOPES['zoom']).toMatchObject({ scope: 'yours' });
    expect(FIXED_SCOPES['zoom']!.text).toContain('only your own');
    expect(FIXED_SCOPES['zoom']!.text).toContain('admin');
  });

  it('Slack, Notion and Teams read everything the token can see, and say which part', () => {
    expect(FIXED_SCOPES['slack']).toMatchObject({ scope: 'team' });
    expect(FIXED_SCOPES['slack']!.text).toContain('channels your token is in');
    expect(FIXED_SCOPES['notion']!.text).toContain('shared with your integration');
    expect(FIXED_SCOPES['teams']!.text).toContain('teams you have joined');
  });
});

describe('discloseTeamScope', () => {
  it('speaks the first time for a source, marks it told, and stays quiet after (two sources)', () => {
    const told = new Set<string>();
    const store = { isTeamScopeDisclosed: (s: string, k: string) => told.has(`${s}|${k}`), markTeamScopeDisclosed: (s: string, k: string) => { told.add(`${s}|${k}`); } };
    const said: string[] = [];
    expect(discloseTeamScope(store, 'github', ['o/r'], (l) => said.push(l))).toBe(true);
    expect(discloseTeamScope(store, 'github', ['o/r'], (l) => said.push(l))).toBe(false);
    expect(discloseTeamScope(store, 'jira', ['ALI'], (l) => said.push(l))).toBe(true);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('everyone in o/r');
    expect([...told]).toEqual(['github|repo:o/r', 'jira|jira:ALI']);
    // a different repo is a different scope: told again
    expect(discloseTeamScope(store, 'github', ['o/other'], (l) => said.push(l))).toBe(true);
  });
});
