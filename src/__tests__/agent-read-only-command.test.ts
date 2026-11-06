import { describe, expect, it } from 'vitest';
import { isReadOnlyCommand } from '../lib/agent/read-only-command.js';

describe('read-only commands pass without asking', () => {
  it.each([
    'git log --oneline --all --grep=trailer -i',
    'git show 64595706 --stat',
    'git status --short',
    'git diff HEAD~1 -- lib/reply.js',
    'git blame -L 1,20 lib/reply.js',
    'ls',
    'ls examples | head -20',
    'find examples -name AGENTS.md -o -name CLAUDE.md',
    'grep -rn "trailer" lib',
    'command -v align',
    'node --version',
    'test -d node_modules && echo dependencies-installed',
    'git status --short; ls examples | head -20; command -v align || true',
    // A quoted separator is part of the argument, not the end of the command.
    "git log --grep='a;b'",
    'git log --grep="a|b" --oneline',
    'grep -rn "trailer stream" lib',
  ])('allows %s', (c) => expect(isReadOnlyCommand(c)).toBe(true));
});

describe('anything that can write, run or chain something else still asks', () => {
  it.each([
    // The security review's case: an allowed `git status` must not approve what follows it.
    ['a second command that is not read-only', 'git status; rm -rf ~'],
    ['a chain whose later half is not read-only', 'ls && rm -rf x'],
    ['a pipe into a shell', 'git log | sh'],
    ['command substitution', 'ls $(rm x)'],
    ['backticks', 'ls `rm x`'],
    ['a redirect that writes a file', 'git log > out.txt'],
    ['a background job', 'ls & rm x'],
    ['a newline-separated second command', 'ls\nrm x'],
    ['find -delete', 'find . -name "*.tmp" -delete'],
    ['find -exec', 'find . -exec rm {} ;'],
    ['git writing a file with --output', 'git log --output=out.txt'],
    ['git running an external diff', 'git diff --ext-diff'],
    ['a git option before the subcommand', 'git -c core.pager=sh log'],
    ['a git subcommand that writes', 'git checkout main'],
    ['an environment prefix', 'FOO=1 ls'],
    ['node running code', 'node -e "1"'],
    // The shell joins quoted pieces, so a quote in the middle of a flag cannot hide it.
    ['find -delete split by quotes', 'find . -d""elete'],
    ['git --output split by quotes', 'git log --out""put=x'],
    ['git --output with the value quoted', 'git log --output"=x"'],
    ['an abbreviated git --output', 'git log --outp=x'],
    ['a chain after a quoted separator', "grep 'a;b' f; rm x"],
    ['an unbalanced quote', "grep 'a f"],
    ['an empty command', ''],
    ['an unknown command', 'curl https://example.com'],
  ])('asks for %s', (_name, c) => expect(isReadOnlyCommand(c)).toBe(false));
});
