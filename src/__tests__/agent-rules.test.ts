import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ALIGN_NUDGE_END,
  ALIGN_NUDGE_START,
  setupAgentAlignment,
  writeAgentsNudge,
  writeClaudeCodeHook,
  writeCursorRule,
  writeManagedNudge,
} from '../lib/agent-rules.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'align-rules-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(rel: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, rel), 'utf8'));
}

describe('writeClaudeCodeHook', () => {
  it('writes a PostToolUse hook matching Write|Edit that runs the advisory check', () => {
    writeClaudeCodeHook(dir);
    const settings = readJson('.claude/settings.json');
    const groups = settings.hooks.PostToolUse;
    expect(Array.isArray(groups)).toBe(true);
    const group = groups.find((g: any) => g.matcher === 'Write|Edit');
    expect(group).toBeDefined();
    const cmd = group.hooks.find((h: any) => h.type === 'command');
    expect(cmd.command).toContain('align check --advisory');
    expect(typeof cmd.timeout).toBe('number');
  });

  it('also writes a PreToolUse hook matching Write|Edit (catch conflicts before the edit)', () => {
    writeClaudeCodeHook(dir);
    const groups = readJson('.claude/settings.json').hooks.PreToolUse;
    expect(Array.isArray(groups)).toBe(true);
    const group = groups.find((g: any) => g.matcher === 'Write|Edit');
    expect(group).toBeDefined();
    expect(group.hooks.find((h: any) => h.type === 'command').command).toContain('align check --advisory');
  });

  it('encodes a non-prod env into the hook command', () => {
    writeClaudeCodeHook(dir, 'preview');
    const settings = readJson('.claude/settings.json');
    const cmd = settings.hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).toContain('--env preview');
  });

  it('omits --env for prod (the default)', () => {
    writeClaudeCodeHook(dir, 'prod');
    const cmd = readJson('.claude/settings.json').hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).not.toContain('--env');
  });

  it('is idempotent - re-running does not duplicate the align hook group in either event', () => {
    writeClaudeCodeHook(dir);
    writeClaudeCodeHook(dir);
    const { hooks } = readJson('.claude/settings.json');
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const alignGroups = hooks[event].filter((g: any) =>
        g.hooks?.some((h: any) => String(h.command).includes('align check --advisory')),
      );
      expect(alignGroups).toHaveLength(1);
    }
  });

  it('preserves unrelated existing settings and hooks', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      }),
    );
    writeClaudeCodeHook(dir);
    const settings = readJson('.claude/settings.json');
    expect(settings.model).toBe('opus');
    const commands = settings.hooks.PostToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toContain('echo hi');
    expect(commands.some((c: string) => c.includes('align check --advisory'))).toBe(true);
  });

  it('throws on invalid existing JSON rather than clobbering it', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json');
    expect(() => writeClaudeCodeHook(dir)).toThrow();
  });
});

describe('writeManagedNudge', () => {
  it('creates CLAUDE.md with a marker-delimited Align block when none exists', () => {
    writeManagedNudge(dir);
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain(ALIGN_NUDGE_START);
    expect(md).toContain(ALIGN_NUDGE_END);
    expect(md.toLowerCase()).toContain('align');
  });

  it('appends to existing CLAUDE.md without dropping prior content', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project\n\nSome rules.\n');
    writeManagedNudge(dir);
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('# My project');
    expect(md).toContain('Some rules.');
    expect(md).toContain(ALIGN_NUDGE_START);
  });

  it('replaces the managed block on re-run instead of duplicating it', () => {
    writeManagedNudge(dir);
    writeManagedNudge(dir);
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md.split(ALIGN_NUDGE_START)).toHaveLength(2); // exactly one block
    expect(md.split(ALIGN_NUDGE_END)).toHaveLength(2);
  });
});

describe('writeAgentsNudge', () => {
  it('creates AGENTS.md with a marker-delimited Align block when none exists', () => {
    writeAgentsNudge(dir);
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain(ALIGN_NUDGE_START);
    expect(md).toContain(ALIGN_NUDGE_END);
    expect(md.toLowerCase()).toContain('decision');
  });

  it('is agent-neutral - does not reference Claude Code hooks (the generic cross-agent file)', () => {
    writeAgentsNudge(dir);
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(md.toLowerCase()).not.toContain('claude code hook');
  });

  it('appends to an existing AGENTS.md without dropping prior content', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# My agents\n\nHouse rules.\n');
    writeAgentsNudge(dir);
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('# My agents');
    expect(md).toContain('House rules.');
    expect(md).toContain(ALIGN_NUDGE_START);
  });

  it('replaces the managed block on re-run instead of duplicating it', () => {
    writeAgentsNudge(dir);
    writeAgentsNudge(dir);
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(md.split(ALIGN_NUDGE_START)).toHaveLength(2);
  });
});

describe('writeCursorRule', () => {
  it('writes .cursor/rules/align.md mentioning the decision graph', () => {
    writeCursorRule(dir);
    const rule = readFileSync(join(dir, '.cursor', 'rules', 'align.md'), 'utf8');
    expect(rule.toLowerCase()).toContain('align');
    expect(rule.toLowerCase()).toContain('decision');
  });
});

describe('setupAgentAlignment', () => {
  it('writes all agent-rule artifacts (incl. generic AGENTS.md) and reports what it wrote', () => {
    const written = setupAgentAlignment({ cwd: dir, env: 'prod' });
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, '.cursor', 'rules', 'align.md'))).toBe(true);
    expect(written).toEqual(
      expect.arrayContaining(['.claude/settings.json', 'CLAUDE.md', 'AGENTS.md', '.cursor/rules/align.md']),
    );
  });
});
