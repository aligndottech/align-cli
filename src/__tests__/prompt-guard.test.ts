import { describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  log: { warn: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

import { guardedPrompt } from '../lib/prompt-guard.js';

/**
 * The align binaries are compiled with `bun build --compile`, so they run on BUN,
 * not Node. That difference is the whole bug: under Node, clack's base Prompt ends
 * up with `value === ""` before the first render, and under Bun it is still
 * `undefined`. Every clack prompt getter that touches `this.value` therefore throws
 * on Bun and not on Node - which is why every reproduction I wrote under Node passed
 * while real users crashed.
 *
 * The tell was in the error text and I missed it twice: Bun phrases it "undefined is
 * not an object (evaluating 'this.value.replaceAll')", Node says "Cannot read
 * properties of undefined". Both David's report and Tom's carried the BUN wording.
 *
 * It is not password-specific. A first fix wrapped only p.password(), and the very
 * next run crashed on GitLab's p.text() instead.
 */
describe('guardedPrompt', () => {
  it('returns the prompt value when nothing goes wrong', async () => {
    const r = await guardedPrompt('GitHub token', () => Promise.resolve('ghp_x'));
    expect(r).toBe('ghp_x');
  });

  it('returns null instead of throwing when the prompt library blows up', async () => {
    const r = await guardedPrompt('GitLab domain', () =>
      Promise.reject(new TypeError("undefined is not an object (evaluating 'this.value.replaceAll')")),
    );
    expect(r).toBeNull();
  });

  it('says which prompt failed, so the log is actionable', async () => {
    await guardedPrompt('GitLab domain', () => Promise.reject(new Error('boom')));
    const warned = clack.log.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('GitLab domain');
  });

  it('does NOT swallow a cancel, which is a normal outcome and not a failure', async () => {
    // Ctrl-C returns clack's cancel symbol rather than throwing. Turning that into
    // null would make a deliberate cancel indistinguishable from a crash.
    const CANCEL = Symbol('clack:cancel');
    const r = await guardedPrompt('anything', () => Promise.resolve(CANCEL));
    expect(r).toBe(CANCEL);
  });
});

describe('guardedPrompt, crash containment (the 0.27.0 field escape)', () => {
  it('removes keypress listeners a crashed prompt left on stdin', async () => {
    // A prompt that throws never runs its close(), so its keypress handler stays
    // bound - and the NEXT prompt's first keystroke fires it against the dead
    // prompt's state. That is how one caught crash still killed the run.
    const stray = () => undefined;
    const before = process.stdin.listenerCount('keypress');
    const result = await guardedPrompt('GitHub', async () => {
      process.stdin.on('keypress', stray);
      throw new Error("undefined is not an object (evaluating 'this.value.replaceAll')");
    });
    expect(result).toBeNull();
    expect(process.stdin.listenerCount('keypress')).toBe(before);
  });

  it('keeps keypress listeners that existed BEFORE the prompt', async () => {
    // The cleanup must be a diff, not a wipe: clack's own long-lived wiring and any
    // host listeners predate the prompt and are not ours to remove.
    const preexisting = () => undefined;
    process.stdin.on('keypress', preexisting);
    try {
      await guardedPrompt('GitHub', async () => {
        throw new Error('boom');
      });
      expect(process.stdin.listeners('keypress')).toContain(preexisting);
    } finally {
      process.stdin.off('keypress', preexisting);
    }
  });

  it('converts an uncaught exception during the prompt into the skip path', async () => {
    // The throw travels through an event callback, so the awaited promise never
    // rejects - without the bridge the process dies via handleFatal. Triggered by
    // calling the installed listener directly rather than emitting through
    // process, so the test runner's own uncaughtException handling stays out of it.
    const before = process.listeners('uncaughtException').length;
    const pending = guardedPrompt('GitLab', () => new Promise<never>(() => {}));
    const added = process.listeners('uncaughtException').slice(before);
    expect(added).toHaveLength(1);
    added[0]!(new Error("undefined is not an object (evaluating 'this.value.replaceAll')"), 'uncaughtException');
    await expect(pending).resolves.toBeNull();
    // And the bridge is gone afterwards - a leaked handler would swallow real crashes.
    expect(process.listeners('uncaughtException').length).toBe(before);
  });

  it('removes the bridge on the happy path too', async () => {
    const before = process.listeners('uncaughtException').length;
    const result = await guardedPrompt('ok', async () => 'fine');
    expect(result).toBe('fine');
    expect(process.listeners('uncaughtException').length).toBe(before);
  });
});
