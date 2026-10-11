import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { addDeliveryOptions, conflictingDeliveryFlags, deliveryFlagsFrom, type DeliveryOpts } from '../lib/share/delivery-options.js';

const parse = (...args: string[]): DeliveryOpts => {
  const c = addDeliveryOptions(new Command().exitOverride());
  c.action(() => undefined);
  c.parse(['node', 'share', ...args]);
  return c.opts<DeliveryOpts>();
};

describe('delivery flags', () => {
  it('--open takes a request id, --no-open turns the browser off, and neither clash on one option name', () => {
    expect(parse('--open', 'abc').open).toBe('abc');
    expect(parse('--no-open').open).toBe(false);
    expect(parse().open).toBeUndefined();
  });
  it('--qr, --no-qr and nothing are three different answers', () => {
    expect(parse('--qr').qr).toBe(true);
    expect(parse('--no-qr').qr).toBe(false);
    expect(parse().qr).toBeUndefined();
  });
  it('maps onto the delivery flags: only an explicit --no-open is noOpen, and an --open id is not', () => {
    expect(deliveryFlagsFrom(parse('--no-open'))).toEqual({ noOpen: true, qr: false, noQr: false });
    expect(deliveryFlagsFrom(parse('--open', 'abc'))).toEqual({ noOpen: false, qr: false, noQr: false });
    expect(deliveryFlagsFrom(parse('--qr'))).toEqual({ noOpen: false, qr: true, noQr: false });
    expect(deliveryFlagsFrom(parse('--no-qr'))).toEqual({ noOpen: false, qr: false, noQr: true });
  });
  it('--copy is opt-in', () => {
    expect(parse().copy).toBeUndefined();
    expect(parse('--copy').copy).toBe(true);
  });
  it('both --qr and --no-qr is flagged, one alone is not', () => {
    expect(conflictingDeliveryFlags(['--qr', '--no-qr'])).toBe(true);
    expect(conflictingDeliveryFlags(['--qr'])).toBe(false);
    expect(conflictingDeliveryFlags(['--no-qr', '--no-open'])).toBe(false);
  });
});
