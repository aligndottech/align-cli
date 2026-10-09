import { describe, expect, it } from 'vitest';
import { carriesLocalEnv } from '../lib/foreign-env.js';

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
