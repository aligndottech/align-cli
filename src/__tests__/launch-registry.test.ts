import { describe, expect, it } from 'vitest';
import { agentByName, LAUNCH_AGENTS } from '../lib/launch/agents.js';
import { AGENT_REGISTRY, specByName } from '../lib/launch/registry/index.js';

// The table as it stood before the registry move (R1 is a pure move: this must not change).
const PRE_MOVE = [
  { name: 'claude-code', label: 'Claude Code', bin: 'claude', injection: 'per-session', supported: true, install: 'npm i -g @anthropic-ai/claude-code' },
  { name: 'codex', label: 'Codex', bin: 'codex', injection: 'per-session', supported: false, install: 'npm i -g @openai/codex' },
  { name: 'cursor', label: 'Cursor', bin: 'cursor-agent', injection: 'written-once', supported: true, install: 'https://cursor.com/cli' },
  { name: 'gemini-cli', label: 'Gemini CLI', bin: 'gemini', injection: 'per-session', supported: false, install: 'npm i -g @google/gemini-cli' },
  { name: 'opencode', label: 'OpenCode', bin: 'opencode', injection: 'per-session', supported: true, install: 'npm i -g opencode-ai' },
  { name: 'pi', label: 'pi', bin: 'pi', injection: 'written-once', supported: true, install: 'https://pi.dev' },
];

describe('agent registry (R1 pure move)', () => {
  it('LAUNCH_AGENTS deep-equals the pre-move table, in order, with no extra keys', () => {
    expect(LAUNCH_AGENTS).toEqual(PRE_MOVE);
    expect(LAUNCH_AGENTS.every((a) => !('build' in a))).toBe(true);
  });

  it('keeps the two named rows: claude-code runs claude, cursor runs cursor-agent written-once', () => {
    expect(agentByName('claude-code')).toMatchObject({ bin: 'claude', injection: 'per-session' });
    expect(agentByName('cursor')).toMatchObject({ bin: 'cursor-agent', injection: 'written-once' });
  });

  it('looks specs up by name and misses on an unknown or undefined name', () => {
    expect(specByName('pi')?.label).toBe('pi');
    expect(specByName('opencode')?.label).toBe('OpenCode');
    expect(specByName('nope')).toBeUndefined();
    expect(specByName(undefined)).toBeUndefined();
  });

  it('has an adapter exactly for the supported agents', () => {
    expect(AGENT_REGISTRY.filter((a) => a.supported).map((a) => a.name)).toEqual(['claude-code', 'cursor', 'opencode', 'pi']);
    for (const a of AGENT_REGISTRY) expect(typeof a.build === 'function', a.name).toBe(a.supported);
  });
});
