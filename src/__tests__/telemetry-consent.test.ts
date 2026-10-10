/**
 * C6: maybeShowTelemetryNotice, called directly. It replaced ALI-618's setup-time consent
 * question (maybeRequestTelemetryConsent): local telemetry is opt-out, and this one-time notice
 * is the disclosure. The end-to-end order (notice before the first send) and every context it
 * is skipped in live in telemetry-notice.test.ts; this file pins the function's own contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import { maybeShowTelemetryNotice, TELEMETRY_NOTICE, type TelemetryNoticeStore } from '../lib/telemetry-consent.js';

function fakeStore(consent?: 'granted' | 'declined' | 'off', shownAt?: string): TelemetryNoticeStore & { marks: number } {
  const store = {
    marks: 0,
    shownAt,
    getTelemetryConsent: () => consent,
    getTelemetryNoticeShownAt: () => store.shownAt,
    markTelemetryNoticeShown: () => {
      store.marks += 1;
      store.shownAt = 'now';
    },
  };
  return store;
}

const ctx = { command: 'ask', hook: false, cloudSignedIn: false };

const realTTY = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
};
function setTTY(stdin: boolean, stderr: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: stderr, configurable: true });
}
function restoreTTY(): void {
  for (const [name, desc] of Object.entries(realTTY)) {
    const stream = name === 'stdin' ? process.stdin : process.stderr;
    if (desc) Object.defineProperty(stream, 'isTTY', desc);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
}

describe('maybeShowTelemetryNotice', () => {
  beforeEach(() => {
    clearTelemetryEnv();
    setTTY(true, true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreTTY();
  });

  // The real default, no seam: with process.stdin/stderr.isTTY as a pipe or /dev/null leaves
  // them (undefined), nothing prints and nothing is marked.
  it('reads the real streams: isTTY undefined on either one means no notice and not marked', () => {
    for (const stream of [process.stdin, process.stderr]) {
      setTTY(true, true);
      delete (stream as { isTTY?: boolean }).isTTY;
      const store = fakeStore();
      const write = vi.fn();
      expect(maybeShowTelemetryNotice(store, ctx, write)).toBe(false);
      expect(write).not.toHaveBeenCalled();
      expect(store.marks).toBe(0);
    }
  });

  it('writes the notice, then a blank line, once, and marks it shown', () => {
    const store = fakeStore();
    const write = vi.fn();
    expect(maybeShowTelemetryNotice(store, ctx, write)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(`${TELEMETRY_NOTICE}\n\n`);
    expect(store.marks).toBe(1);

    expect(maybeShowTelemetryNotice(store, ctx, write)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('defaults to stderr, never stdout (stdout is a command\'s machine output)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      maybeShowTelemetryNotice(fakeStore(), ctx);
      expect(err).toHaveBeenCalledWith(`${TELEMETRY_NOTICE}\n\n`);
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it.each(['granted', 'declined', 'off'] as const)('a stored "%s" decision: no notice, not marked', (consent) => {
    const store = fakeStore(consent);
    const write = vi.fn();
    expect(maybeShowTelemetryNotice(store, ctx, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(store.marks).toBe(0);
  });

  it('a broken store costs the notice, never the command', () => {
    const write = vi.fn();
    const broken = {
      getTelemetryConsent: () => { throw new Error('disk'); },
      getTelemetryNoticeShownAt: () => undefined,
      markTelemetryNoticeShown: () => {},
    };
    expect(maybeShowTelemetryNotice(broken, ctx, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
