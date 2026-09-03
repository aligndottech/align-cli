/**
 * ALI-808 shared contract: the agent name lives in the source_url scheme
 * (`<agent>-session://<sessionId>/<messageId>`), never in `platform` (always
 * 'agent-session'). Two agents, so a hardcoded scheme cannot pass.
 *
 * Test List:
 * 1. builds the scheme for two different agents/ids
 * 2. round-trips: parse(build(...)) recovers the same triple
 * 3. parse returns null for a URL that is not this scheme
 */
import { describe, expect, it } from 'vitest';
import { buildSessionSourceUrl, parseSessionSourceUrl } from '../../lib/sessions/source-url.js';

describe('buildSessionSourceUrl', () => {
  it('builds the claude-code scheme', () => {
    expect(buildSessionSourceUrl('claude-code', 'e492e4bb-afa3', 'toolu_01LeVZxy')).toBe(
      'claude-code-session://e492e4bb-afa3/toolu_01LeVZxy',
    );
  });

  it('builds the pi scheme with different ids, so the format is not hardcoded to one agent', () => {
    expect(buildSessionSourceUrl('pi', '01a052fb-1473', 'b75896a2')).toBe(
      'pi-session://01a052fb-1473/b75896a2',
    );
  });
});

describe('parseSessionSourceUrl', () => {
  it('round-trips a built URL back to its triple', () => {
    const url = buildSessionSourceUrl('codex', 'sess-1', 'msg-2');
    expect(parseSessionSourceUrl(url)).toEqual({ agent: 'codex', sessionId: 'sess-1', messageId: 'msg-2' });
  });

  it('returns null for a URL that is not an agent-session scheme', () => {
    expect(parseSessionSourceUrl('https://github.com/aligndottech/align-cli/pull/1')).toBeNull();
  });
});
