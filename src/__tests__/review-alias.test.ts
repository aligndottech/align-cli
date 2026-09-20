/**
 * `align review` must actually resolve, and must be the SAME command as `align check`.
 *
 * Asserting identity rather than existence: a `review` command that resolved to something
 * else, or to a stub, would satisfy "it exists" while giving the person who asked for it a
 * different answer than the one the engine produces.
 */
import { describe, expect, it } from 'vitest';

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
