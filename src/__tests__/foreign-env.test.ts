import { describe, expect, it } from 'vitest';
import { carriesLocalEnv, projectForeignNotice } from '../lib/foreign-env.js';

describe('carriesLocalEnv', () => {
  it.each([
    ['a hook command', 'align check --advisory --env local'],
    ['a JSON args array', '{"command":"align","args":["mcp","--env","local"]}'],
    ['an OpenCode command array', '{"type":"local","command":["align","mcp","--env","local"]}'],
    ['a pretty-printed array', '"args": [\n  "mcp",\n  "--env",\n  "local"\n]'],
    ['the --env=local spelling', 'align mcp --env=local'],
    ['a generated plugin', 'execFile(ALIGN_BIN, [...ALIGN_PRE, "mcp", "--env", "local"])'],
  ])('is true for %s', (_name, text) => {
    expect(carriesLocalEnv(text)).toBe(true);
  });

  it.each([
    ['no --env at all (that is prod)', '{"command":"align","args":["mcp"]}'],
    ['a preview env', '{"command":"align","args":["mcp","--env","preview"]}'],
    ['an OpenCode prod command array', '{"type":"local","command":["align","mcp"]}'],
    ['"type":"local" alone, which is a transport and not an env', '{"type":"local","command":["align","mcp","--env","prod"]}'],
    ['a "local" word with no --env before it', 'align check --advisory # local graph'],
    ['--env localhost', 'align mcp --env localhost'],
  ])('is false for %s', (_name, text) => {
    expect(carriesLocalEnv(text)).toBe(false);
  });
});

describe('projectForeignNotice', () => {
  it('says nothing when no project file was skipped', () => {
    expect(projectForeignNotice([])).toBeUndefined();
  });

  it('is ONE line naming every skipped project file once, with the by-hand fix', () => {
    const line = projectForeignNotice(['.mcp.json', '.claude/settings.json', '.mcp.json']);
    expect(line).toBe(
      'Left the existing align entry as is in .mcp.json, .claude/settings.json (committed project files, not set to --env local). Edit them by hand to use the local graph.',
    );
    expect(line).not.toContain('\n');
  });

  it('is singular for one file', () => {
    expect(projectForeignNotice(['.mcp.json'])).toBe(
      'Left the existing align entry as is in .mcp.json (a committed project file, not set to --env local). Edit it by hand to use the local graph.',
    );
  });
});
