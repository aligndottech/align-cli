/**
 * A synthesised answer is markdown-shaped prose from a model, printed to a terminal.
 * The terminal has no markdown renderer, so the asterisks land on screen as asterisks
 * (Tom, 2026-09-03: `Your team does **not** uniformly fail open`). One pure function
 * turns the inline markers a model actually emits into ANSI, and applies the house
 * no-em-dash rule at the print site so it holds for every path, cloud answers included.
 */
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { renderAnswer } from '../lib/answer-render.js';

describe('renderAnswer', () => {
  it('turns **bold** into ANSI bold and drops the asterisks', () => {
    expect(renderAnswer('Your team does **not** fail open.')).toBe(`Your team does ${chalk.bold('not')} fail open.`);
  });

  it('handles several bold spans in one answer', () => {
    expect(renderAnswer('**fail-closed** here, **fail-open** there')).toBe(
      `${chalk.bold('fail-closed')} here, ${chalk.bold('fail-open')} there`,
    );
  });

  it('turns `code` spans into a highlighted span', () => {
    expect(renderAnswer('set `LICENSE_ENFORCEMENT_ENABLED` off')).toBe(`set ${chalk.cyan('LICENSE_ENFORCEMENT_ENABLED')} off`);
  });

  it('leaves an unmatched marker alone rather than eating text', () => {
    expect(renderAnswer('a ** b')).toBe('a ** b');
    expect(renderAnswer('rate is 5*2*3')).toBe('rate is 5*2*3');
  });

  it('replaces em-dashes and en-dashes with the house " - ", whatever the spacing', () => {
    expect(renderAnswer('webhooks—the posture varies')).toBe('webhooks - the posture varies');
    expect(renderAnswer('an exception — it is open')).toBe('an exception - it is open');
    expect(renderAnswer('2024–2026')).toBe('2024 - 2026');
  });

  it('returns plain prose unchanged', () => {
    const plain = 'Most connectors reject deliveries when the secret is missing.';
    expect(renderAnswer(plain)).toBe(plain);
  });
});
