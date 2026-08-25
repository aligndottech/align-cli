/**
 * ALI-675: the retry command printed when a connector import fails mid-setup
 * must be runnable AS PRINTED by the user this session belongs to. The bare
 * form resolves to the default env, which is wrong for any non-prod session.
 */
import { describe, expect, it } from 'vitest';
import { importRetryHint } from '../commands/setup.js';

describe('importRetryHint (ALI-675)', () => {
  it('names the env for a non-prod session, so pasting it targets the session graph', () => {
    expect(importRetryHint('jira', 'local')).toBe('align import jira --env local');
    expect(importRetryHint('slack', 'preview')).toBe('align import slack --env preview');
  });

  it('prints the bare command for prod, the unmarked default (same convention as the MCP writer)', () => {
    expect(importRetryHint('jira', 'prod')).toBe('align import jira');
  });
});
