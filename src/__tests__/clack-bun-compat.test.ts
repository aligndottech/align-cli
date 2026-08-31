import { describe, expect, it } from 'vitest';
import { PasswordPrompt, TextPrompt } from '@clack/core';
import { applyClackBunCompat } from '../lib/clack-bun-compat.js';

/**
 * On Bun (the shipped binaries), @clack/core 0.4.1 leaves `this.value` undefined in
 * states Node never reaches, and two getters read it bare:
 *   PasswordPrompt.masked          this.value.replaceAll(...)
 *   TextPrompt.valueWithCursor     this.value.length / .slice(...)
 *
 * Observed in the field THREE times (0.25.x, 0.26.x, 0.27.0), the last one via a
 * stale keypress listener from an already-crashed prompt poisoning the NEXT prompt -
 * which is why a text prompt died with the password getter's error message.
 */
describe('applyClackBunCompat', () => {
  function bareInstance<T>(cls: new (opts: never) => T): T {
    // The Bun state, constructed directly: a prompt whose value was never set.
    // Object.create skips the constructor, exactly like a listener firing on a
    // prompt whose stream wiring never ran.
    return Object.create(cls.prototype) as T;
  }

  it('is needed: the unpatched getters throw on undefined value (positive control)', () => {
    // Read the ORIGINAL descriptors saved by the patch, so this control cannot rot
    // into testing the patched behaviour after some other test imports the module.
    const { originals } = applyClackBunCompat();
    const raw = bareInstance(PasswordPrompt as never) as { _mask?: string };
    raw._mask = '*';
    expect(() => originals.masked.call(raw)).toThrow(/replaceAll|undefined/);
  });

  it('masked returns an empty mask instead of throwing', () => {
    applyClackBunCompat();
    const prompt = bareInstance(PasswordPrompt as never) as { _mask?: string; masked?: string };
    prompt._mask = '*';
    expect(prompt.masked).toBe('');
  });

  it('valueWithCursor renders a bare cursor instead of throwing', () => {
    applyClackBunCompat();
    const prompt = bareInstance(TextPrompt as never) as Record<string, unknown>;
    prompt.state = 'active';
    prompt._cursor = 0;
    expect(() => (prompt as { valueWithCursor?: string }).valueWithCursor).not.toThrow();
  });

  it('leaves defined values exactly as the original getter renders them', () => {
    applyClackBunCompat();
    const prompt = bareInstance(PasswordPrompt as never) as Record<string, unknown>;
    prompt._mask = '*';
    prompt.value = 'abc';
    Object.defineProperty(prompt, '_cursor', { value: 3 });
    expect((prompt as { masked?: string }).masked).toBe('***');
  });

  it('is idempotent: applying twice keeps ONE wrapper, not a chain', () => {
    const first = applyClackBunCompat();
    const second = applyClackBunCompat();
    expect(second.alreadyApplied).toBe(true);
    expect(second.originals.masked).toBe(first.originals.masked);
  });
});
