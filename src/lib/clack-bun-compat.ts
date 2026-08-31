import { PasswordPrompt, TextPrompt } from '@clack/core';

/**
 * Bun-compat patch for @clack/core 0.4.1, applied once at CLI startup.
 *
 * The shipped binaries run on Bun, where a prompt's `this.value` can still be
 * undefined in states Node never reaches - and worse, a prompt that crashed leaves
 * its keypress listener on stdin, so the NEXT prompt's first keystroke fires the
 * dead prompt's handlers against that undefined value. That is how a text prompt
 * died with PasswordPrompt.masked's error in the field (0.27.0), after the guard
 * had correctly caught the first crash.
 *
 * Two getters read `this.value` bare; both are wrapped to treat undefined as ''.
 * Everything else about the getters is the ORIGINAL implementation, called through,
 * so rendering behaviour cannot drift from upstream.
 *
 * This works because @clack/prompts resolves the same @clack/core instance we
 * import (single copy, `npm ls @clack/core` shows one dedup'd node; bun's bundler
 * resolves identically at compile time), and @clack/core is a direct dependency so
 * that resolution is declared rather than inherited.
 *
 * Retire when @clack is upgraded to 1.x, which fixes the initialisation upstream.
 */

type Original = (this: unknown) => unknown;

let applied: { masked: Original; valueWithCursor: Original } | null = null;

export function applyClackBunCompat(): {
  alreadyApplied: boolean;
  originals: { masked: Original; valueWithCursor: Original };
} {
  if (applied) return { alreadyApplied: true, originals: applied };

  const maskedDesc = Object.getOwnPropertyDescriptor(PasswordPrompt.prototype, 'masked');
  const cursorDesc = Object.getOwnPropertyDescriptor(TextPrompt.prototype, 'valueWithCursor');
  if (!maskedDesc?.get || !cursorDesc?.get) {
    // The library changed shape (an upgrade landed without retiring this). Refuse
    // loudly rather than patching nothing and reporting success.
    throw new Error('clack-bun-compat: expected getters are missing; retire or update this patch');
  }
  const originals = { masked: maskedDesc.get as Original, valueWithCursor: cursorDesc.get as Original };

  Object.defineProperty(PasswordPrompt.prototype, 'masked', {
    configurable: true,
    get(this: { value?: unknown }) {
      if (this.value === undefined) this.value = '';
      return originals.masked.call(this);
    },
  });
  Object.defineProperty(TextPrompt.prototype, 'valueWithCursor', {
    configurable: true,
    get(this: { value?: unknown }) {
      if (this.value === undefined) this.value = '';
      return originals.valueWithCursor.call(this);
    },
  });

  applied = originals;
  return { alreadyApplied: false, originals };
}
