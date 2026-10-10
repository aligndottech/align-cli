/**
 * How an approval link reaches the person: opened for them, shown as a QR code to scan with a phone, or both
 * unavailable (then it is only printed, as before).
 *
 * decideDelivery is a pure table over the machine and the flags, so every row is testable without a terminal.
 * openApprovalLink runs the link through the allowlist and then spawns an OS opener with an ARGUMENT VECTOR: no
 * shell, no PowerShell string, no `start`. The `open` package is not used here on purpose: on Windows it builds a
 * PowerShell double-quoted string, which is the thing that must never see a link built from config.
 *
 * ARGV VISIBILITY. On Linux (xdg-open) and macOS (open) the full link, including the `#k=` key, is on the opener's
 * command line while it runs, so another local user can read it with `ps`. The key alone cannot approve anything: the
 * approve route needs the same person's signed-in browser session and, where enabled, their passkey. Every route that
 * hands a link to a browser from here (a file, a pipe, a local redirect page) leaves the key somewhere longer-lived or
 * equally visible, so argv is the least bad option. Where that matters, use `--no-open` and the QR code.
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
type Platform = typeof process.platform;
import { checkApproveLink } from './approve-link.js';
import { tryOpenUrl } from '../open-url.js';

export interface DeliveryEnv {
  platform: Platform;
  env: Record<string, string | undefined>;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  /** Running inside a container (a Docker or Podman guest), where a browser is not the person's. */
  inContainer: boolean;
}
export interface DeliveryFlags {
  /** --no-open */
  noOpen?: boolean;
  /** --qr: print the QR code even when stdout is not a terminal. Also means: do not open a browser here. */
  qr?: boolean;
  /** --no-qr: never print it. Wins over --qr. */
  noQr?: boolean;
}
export interface DeliveryPlan {
  open: boolean;
  qr: boolean;
  /** When the browser launch fails, a QR is still worth printing (a terminal, not CI, and not --no-qr). */
  qrIfOpenFails: boolean;
  why: string;
}

const set = (v: string | undefined): boolean => v !== undefined && v !== '';
/** CI=false and CI=0 are how people turn it OFF; an empty value is unset. */
const isCi = (env: DeliveryEnv['env']): boolean => (set(env['CI']) && !/^(false|0)$/i.test(env['CI']!)) || set(env['GITHUB_ACTIONS']);
const isSsh = (env: DeliveryEnv['env']): boolean => set(env['SSH_CONNECTION']) || set(env['SSH_TTY']) || set(env['SSH_CLIENT']);
const isRemoteDev = (env: DeliveryEnv['env']): boolean => set(env['CODESPACES']) || set(env['REMOTE_CONTAINERS']);

/** Pure. Opening needs a person at a terminal on a machine with a browser; the QR is for every other terminal. */
export function decideDelivery(e: DeliveryEnv, f: DeliveryFlags): DeliveryPlan {
  const ci = isCi(e.env);
  const noBrowser =
    f.noOpen ? '--no-open'
    : f.qr ? '--qr'
    : !e.stdoutIsTTY || !e.stdinIsTTY ? 'not an interactive terminal'
    : ci ? 'CI'
    : isSsh(e.env) ? 'SSH session'
    : isRemoteDev(e.env) ? 'remote dev environment'
    : e.inContainer ? 'container'
    : e.platform === 'linux' && !set(e.env['DISPLAY']) && !set(e.env['WAYLAND_DISPLAY']) ? 'no display'
    : null;
  const open = noBrowser === null;
  // The QR goes where the link goes (stdout), so it needs a terminal there unless forced. CI never gets one unprompted.
  const qr = f.noQr ? false : f.qr ? true : !open && e.stdoutIsTTY && !ci;
  return { open, qr, qrIfOpenFails: !f.noQr && e.stdoutIsTTY && !ci, why: noBrowser ?? 'interactive terminal on a machine with a browser' };
}

export function currentDeliveryEnv(): DeliveryEnv {
  let inContainer = false;
  try { inContainer = process.platform === 'linux' && (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || set(process.env['container'])); } catch { /* unknown is not a container */ }
  return { platform: process.platform, env: process.env, stdoutIsTTY: process.stdout.isTTY === true, stdinIsTTY: process.stdin.isTTY === true, inContainer };
}

/** One executable and its arguments. The link is exactly one argument. */
export function browserLaunch(platform: Platform, url: string, env: Record<string, string | undefined> = process.env): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    // An absolute path: a bare `rundll32` is searched for in the working directory first on Windows, so a rundll32.exe in a
    // cloned repo would run. SystemRoot is used only when it is absolute (a relative value would be the cwd again).
    const root = env['SystemRoot'] !== undefined && path.win32.isAbsolute(env['SystemRoot']) && /^[A-Za-z]:\\/.test(env['SystemRoot']) ? env['SystemRoot'] : 'C:\\Windows';
    return { command: path.win32.join(root, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

export interface OpenDeps {
  platform?: Platform;
  spawn?: typeof nodeSpawn;
  graceMs?: number;
  env?: Record<string, string | undefined>;
}

/** False without spawning anything when the link does not pass the allowlist. */
export async function openApprovalLink(url: string, appUrl: string, deps: OpenDeps = {}): Promise<boolean> {
  if (!checkApproveLink(url, appUrl).ok) return false;
  const { command, args } = browserLaunch(deps.platform ?? process.platform, url, deps.env);
  const spawnFn = deps.spawn ?? nodeSpawn;
  const opener = async (): Promise<ChildProcess> => {
    const child = spawnFn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
    return child;
  };
  return tryOpenUrl(url, opener as never, deps.graceMs);
}

/** What the approval step needs to put the link in front of the person. */
export interface PresentDeps {
  appUrl: string;
  plan: DeliveryPlan;
  /** Absent: nothing is opened. */
  openUrl?: (url: string) => Promise<boolean>;
  /** Builds the QR lines for a link; absent: no QR. */
  qr?: (url: string) => { lines: string[]; columns: number };
  /** Terminal width when known: a QR wider than this is not printed (it would wrap and not scan). */
  columns?: number;
  /** Ordinary lines (cleaned of control characters by the caller). */
  out: (line: string) => void;
  /** QR lines only: they carry colour escapes, which the caller's cleaning would turn into visible junk. We built them from a link that passed the allowlist. */
  raw: (line: string) => void;
  /** --copy: ask the terminal to put the link on the clipboard. */
  copy?: (url: string) => void;
}

const HOW_WITH_QR = 'To open it: scan the QR code with your phone (approving there with Face ID or a fingerprint is the strongest way), or open the link above on any device where you are signed in to Align.';
const HOW_NO_QR = 'To open it: open the link above on any device where you are signed in to Align, a phone included.';

export async function presentLink(url: string, d: PresentDeps): Promise<void> {
  const check = checkApproveLink(url, d.appUrl);
  if (!check.ok) {
    d.out('This link does not have the shape of an Align approval link, so it was not opened and no QR code was made. Check it before you open it.');
    return;
  }
  const showQr = (): boolean => {
    if (!d.qr) return false;
    const r = d.qr(url);
    if (d.columns !== undefined && d.columns < r.columns) {
      d.out(`Your terminal is ${d.columns} columns wide and the QR code needs ${r.columns}. Widen it and run the share again, or open the link above.`);
      return false;
    }
    d.out('Scan this with your phone camera:');
    for (const l of r.lines) d.raw(l);
    return true;
  };
  let shownQr = false;
  if (d.plan.qr) shownQr = showQr();
  if (d.copy) { d.copy(url); d.out('Asked your terminal to copy the link. Not every terminal allows it, so check before you paste.'); }
  if (d.plan.open && d.openUrl) {
    if (await d.openUrl(url)) return;
    d.out('Could not open a browser here. Open the link above yourself.');
    if (!shownQr && d.plan.qrIfOpenFails) shownQr = showQr();
  }
  d.out(shownQr ? HOW_WITH_QR : HOW_NO_QR);
}

/** The OSC 52 "copy to clipboard" sequence for a link, or null when stdout is not a terminal (it would print as junk in a pipe). */
export function osc52(url: string, stdoutIsTTY: boolean): string | null {
  if (!stdoutIsTTY) return null;
  let origin: string;
  try { origin = new URL(url).origin; } catch { return null; }
  if (!checkApproveLink(url, origin).ok) return null;
  return `\u001b]52;c;${Buffer.from(url, 'utf8').toString('base64')}\u0007`;
}
