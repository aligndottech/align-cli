import { describe, expect, it } from 'vitest';
import { agentByName, LAUNCH_AGENTS } from '../lib/launch/agents.js';
import { AGENT_REGISTRY, specByName } from '../lib/launch/registry/index.js';

// The table: R1's pure move, plus wave A (Codex and Gemini CLI turned on, Copilot added), plus waves B and C.
const PRE_MOVE = [
  { name: 'claude-code', label: 'Claude Code', bin: 'claude', injection: 'per-session', supported: true, install: 'npm i -g @anthropic-ai/claude-code' },
  { name: 'codex', label: 'Codex', bin: 'codex', injection: 'per-session', supported: true, install: 'npm i -g @openai/codex' },
  { name: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot', injection: 'per-session', supported: true, install: 'npm i -g @github/copilot' },
  { name: 'cursor', label: 'Cursor', bin: 'cursor-agent', injection: 'written-once', supported: true, install: 'https://cursor.com/cli' },
  { name: 'gemini-cli', label: 'Gemini CLI', bin: 'gemini', injection: 'written-once', supported: true, install: 'npm i -g @google/gemini-cli' },
  { name: 'opencode', label: 'OpenCode', bin: 'opencode', injection: 'per-session', supported: true, install: 'npm i -g opencode-ai' },
  { name: 'pi', label: 'pi', bin: 'pi', injection: 'written-once', supported: true, install: 'https://pi.dev' },
  // wave B
  { name: 'amp', label: 'Amp', bin: 'amp', injection: 'written-once', supported: true, install: 'curl -fsSL https://ampcode.com/install.sh | bash' },
  { name: 'droid', label: 'Factory Droid', bin: 'droid', injection: 'per-session', supported: true, install: 'curl -fsSL https://app.factory.ai/cli | sh' },
  { name: 'grok-build', label: 'Grok Build', bin: 'grok', injection: 'written-once', supported: true, install: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
  { name: 'kiro', label: 'Kiro CLI', bin: 'kiro-cli', injection: 'written-once', supported: true, install: 'curl -fsSL https://cli.kiro.dev/install | bash' },
  { name: 'qwen', label: 'Qwen Code', bin: 'qwen', injection: 'per-session', supported: true, install: 'npm i -g @qwen-code/qwen-code' },
  // wave C
  { name: 'aider', label: 'Aider', bin: 'aider', injection: 'per-session', supported: true, install: 'python -m pip install aider-install && aider-install' },
  { name: 'auggie', label: 'Auggie', bin: 'auggie', injection: 'written-once', supported: true, install: 'npm i -g @augmentcode/auggie' },
  { name: 'cline', label: 'Cline', bin: 'cline', injection: 'written-once', supported: true, install: 'npm i -g cline' },
  { name: 'continue', label: 'Continue CLI', bin: 'cn', injection: 'per-session', supported: true, install: 'npm i -g @continuedev/cli' },
  { name: 'goose', label: 'Goose', bin: 'goose', injection: 'per-session', supported: true, install: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash' },
];

describe('agent registry', () => {
  it('LAUNCH_AGENTS deep-equals the table, in order, with no extra keys', () => {
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
    expect(AGENT_REGISTRY.filter((a) => a.supported).map((a) => a.name)).toEqual(['claude-code', 'codex', 'copilot', 'cursor', 'gemini-cli', 'opencode', 'pi', 'amp', 'droid', 'grok-build', 'kiro', 'qwen', 'aider', 'auggie', 'cline', 'continue', 'goose']);
    for (const a of AGENT_REGISTRY) expect(typeof a.build === 'function', a.name).toBe(a.supported);
  });
});
