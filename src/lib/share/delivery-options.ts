/** The command-line flags that steer how the approval link is delivered, declared once so a test can parse them without running a share. */
import type { Command } from 'commander';
import type { DeliveryFlags } from './delivery.js';

export interface DeliveryOpts {
  /** `--no-open` gives false; `--open <id>` gives the id. */
  open?: string | boolean;
  /** `--qr` gives true, `--no-qr` false. */
  qr?: boolean;
  copy?: boolean;
}

export function addDeliveryOptions(cmd: Command): Command {
  return cmd
    .option('--open <request-id>', 'Show the approval link again (open it, or print it with a QR code) for a request your agent staged on this machine')
    .option('--no-open', 'Print the approval link without opening a browser')
    .option('--qr', 'Print a QR code of the approval link, even when output is not a terminal; scan it with your phone')
    .option('--no-qr', 'Never print the QR code')
    .option('--copy', 'Ask your terminal to copy the approval link (needs a terminal that supports OSC 52; the link then sits in your clipboard)');
}

export function deliveryFlagsFrom(o: DeliveryOpts): DeliveryFlags {
  return { noOpen: o.open === false, qr: o.qr === true, noQr: o.qr === false };
}

/** Both `--qr` and `--no-qr` is a mistake worth stopping on, rather than guessing which one was meant. */
export function conflictingDeliveryFlags(argv: readonly string[]): boolean {
  return argv.includes('--qr') && argv.includes('--no-qr');
}
