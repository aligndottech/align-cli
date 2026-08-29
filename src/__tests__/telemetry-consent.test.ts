/**
 * ALI-618 D3/align-cli#118: the one-time local-mode consent prompt. Never asks twice - a
 * decision already on disk is left alone - and never blocks or crashes a non-interactive run,
 * the same TTY-gating lesson setup-local-non-tty.test.ts pins for the connector prompt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfirm = vi.fn();
const mockIsCancel = vi.fn(() => false);

vi.mock('@clack/prompts', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  isCancel: (v: unknown) => mockIsCancel(v),
}));

import { maybeRequestTelemetryConsent } from '../lib/telemetry-consent.js';

function fakeConfig(initial: 'granted' | 'declined' | undefined = undefined) {
  let consent = initial;
  return {
    getTelemetryConsent: vi.fn(() => consent),
    setTelemetryConsent: vi.fn((v: 'granted' | 'declined') => {
      consent = v;
    }),
  };
}

describe('maybeRequestTelemetryConsent', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    mockIsCancel.mockReset();
    mockIsCancel.mockReturnValue(false);
  });

  // test 1
  it('non-TTY, no consent recorded: no prompt, consent stays unset', async () => {
    const config = fakeConfig(undefined);

    await maybeRequestTelemetryConsent(config, false);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(config.setTelemetryConsent).not.toHaveBeenCalled();
    expect(config.getTelemetryConsent()).toBeUndefined();
  });

  // test 2
  it('consent already declined: does not ask again, even when interactive', async () => {
    const config = fakeConfig('declined');

    await maybeRequestTelemetryConsent(config, true);

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // Second example for the same rule: a prior grant is also never re-asked.
  it('consent already granted: does not ask again', async () => {
    const config = fakeConfig('granted');

    await maybeRequestTelemetryConsent(config, true);

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('interactive, no consent recorded, user answers yes: records granted', async () => {
    mockConfirm.mockResolvedValue(true);
    const config = fakeConfig(undefined);

    await maybeRequestTelemetryConsent(config, true);

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(config.setTelemetryConsent).toHaveBeenCalledWith('granted');
  });

  it('interactive, user answers no: records declined', async () => {
    mockConfirm.mockResolvedValue(false);
    const config = fakeConfig(undefined);

    await maybeRequestTelemetryConsent(config, true);

    expect(config.setTelemetryConsent).toHaveBeenCalledWith('declined');
  });

  // Ctrl-C: "anything other than an explicit yes leaves it off" (D3).
  it('interactive, user cancels (Ctrl-C): records declined, not left unset', async () => {
    mockConfirm.mockResolvedValue(Symbol('cancel'));
    mockIsCancel.mockReturnValue(true);
    const config = fakeConfig(undefined);

    await maybeRequestTelemetryConsent(config, true);

    expect(config.setTelemetryConsent).toHaveBeenCalledWith('declined');
  });

  it('defaults the prompt to No', async () => {
    mockConfirm.mockResolvedValue(false);
    const config = fakeConfig(undefined);

    await maybeRequestTelemetryConsent(config, true);

    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({ initialValue: false });
  });
});
