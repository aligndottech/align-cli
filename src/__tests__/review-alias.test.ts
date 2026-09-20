/**
 * `align review` must actually resolve, and must be the SAME command as `align check`.
 *
 * Asserting identity rather than existence: a `review` command that resolved to something
 * else, or to a stub, would satisfy "it exists" while giving the person who asked for it a
 * different answer than the one the engine produces.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildProgram } from '../cli.js';

describe('align review (David feedback, 2026-09-20)', () => {
  const findCheck = () => {
    const program = buildProgram({ exitOverride: true });
    return program.commands.find((c) => c.name() === 'check');
  };

  it('registers `review` as an alias of check', () => {
    const check = findCheck();
    expect(check).toBeDefined();
    expect(check?.aliases()).toContain('review');
  });

  /**
   * The positive control beside the negative: proves the program really did build commands,
   * so a `review`-shaped absence elsewhere means absence rather than an empty program.
   */
  it('does not register review as a SEPARATE command', () => {
    const program = buildProgram({ exitOverride: true });
    expect(program.commands.length).toBeGreaterThan(5);
    expect(program.commands.filter((c) => c.name() === 'review')).toHaveLength(0);
  });

  it('exposes the PR-shaped options through the alias', () => {
    const check = findCheck();
    const flags = (check?.options ?? []).map((o) => o.long);
    expect(flags).toContain('--base');
    expect(flags).toContain('--title');
  });
});

/**
 * The branch fallback must stay out of hook mode.
 *
 * Copilot, #309: `--hook` is documented as silent when there is no context. The fallback makes
 * an empty-diff invocation check the WHOLE branch instead, so a pre-commit hook would emit
 * output and could fail the commit on a historical conflict in code the author never touched.
 *
 * Asserted against the source rather than by driving the command, because the condition lives
 * inside a 640-line action closure that needs a gateway, a config store and a git repo to
 * reach. A source assertion is weaker than a behavioural one and is the honest trade here;
 * it is scoped to the one condition so it cannot pass by matching `opts.hook` elsewhere.
 */
describe("the branch fallback is excluded from hook mode (ALI-1105)", () => {
  const source = readFileSync(
    join(__dirname, "..", "commands", "check.ts"),
    "utf8",
  );

  it("guards the fallback on !opts.hook as well as !opts.ci", () => {
    const condition = source.match(/if \(!diff\.trim\(\)[^)]*\)\s*\{/);
    expect(condition, "the empty-diff fallback condition should exist").toBeTruthy();
    expect(condition?.[0]).toContain("!opts.ci");
    expect(
      condition?.[0],
      "a --hook run must not fall back to checking the whole branch",
    ).toContain("!opts.hook");
  });
});
