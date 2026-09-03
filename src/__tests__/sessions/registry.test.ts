/**
 * Test List:
 * 1. ADAPTERS has exactly one entry per AgentName, all six
 * 2. detectAgents returns only agents that actually found session files here
 * 3. an agent with zero files is silently excluded, not reported as an error
 * 4. the result carries fixtureVerified, so a caller can warn before using an unverified one
 */
import { describe, expect, it } from 'vitest';
import { ADAPTERS, detectAgents } from '../../lib/sessions/registry.js';
import type { AgentName, SessionAdapter } from '../../lib/sessions/types.js';

function fakeAdapter(agent: AgentName, files: string[], fixtureVerified = true): SessionAdapter {
  return { agent, fixtureVerified, locateSessionFiles: () => files, parseSession: () => null };
}

describe('ADAPTERS', () => {
  it('has exactly one entry per agent name, all six', () => {
    const agents = ADAPTERS.map(a => a.agent).sort();
    expect(agents).toEqual(['claude-code', 'codex', 'cursor', 'gemini-cli', 'opencode', 'pi']);
  });
});

describe('detectAgents', () => {
  it('returns only agents with at least one located session file', () => {
    const found = detectAgents('/some/project', [
      fakeAdapter('claude-code', ['/a/one.jsonl']),
      fakeAdapter('pi', []),
      fakeAdapter('codex', ['/c/one.jsonl', '/c/two.jsonl']),
    ]);
    expect(found.map(f => f.adapter.agent)).toEqual(['claude-code', 'codex']);
    expect(found.find(f => f.adapter.agent === 'codex')!.files).toHaveLength(2);
  });

  it('excludes a zero-file agent silently, not as an error entry', () => {
    const found = detectAgents('/some/project', [fakeAdapter('gemini-cli', [])]);
    expect(found).toEqual([]);
  });

  it('carries fixtureVerified through, so callers can warn before using an unverified adapter', () => {
    const found = detectAgents('/some/project', [fakeAdapter('cursor', ['/x.jsonl'], false)]);
    expect(found[0].adapter.fixtureVerified).toBe(false);
  });
});
