import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { browserLaunch, decideDelivery, type DeliveryEnv, type DeliveryFlags, openApprovalLink } from '../lib/share/delivery.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const APP = 'https://app.align.test';
const LINK = `${APP}/share/approve/${ID}#k=${'B'.repeat(43)}`;

const base = (o: Partial<DeliveryEnv> & { env?: Record<string, string | undefined> } = {}): DeliveryEnv => ({
  platform: 'darwin', stdoutIsTTY: true, stdinIsTTY: true, inContainer: false, ...o, env: { ...(o.env ?? {}) },
});
const linux = (env: Record<string, string | undefined> = { DISPLAY: ':0' }, o: Partial<DeliveryEnv> = {}): DeliveryEnv => base({ platform: 'linux', ...o, env });

describe('decideDelivery: who gets the link opened for them, and who gets a QR code', () => {
  // [name, environment, flags, open, qr]
  const rows: Array<[string, DeliveryEnv, DeliveryFlags, boolean, boolean]> = [
    ['macOS at a terminal opens, no QR', base(), {}, true, false],
    ['Windows at a terminal opens, no QR', base({ platform: 'win32' }), {}, true, false],
    ['Linux with X11 opens', linux({ DISPLAY: ':0' }), {}, true, false],
    ['Linux with Wayland opens', linux({ WAYLAND_DISPLAY: 'wayland-0' }), {}, true, false],
    ['Linux with no display shows a QR instead', linux({}), {}, false, true],
    ['Linux with an EMPTY display var counts as no display', linux({ DISPLAY: '', WAYLAND_DISPLAY: '' }), {}, false, true],
    ['SSH_CONNECTION: QR, no open (even with a display forwarded)', linux({ DISPLAY: ':10', SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' }), {}, false, true],
    ['SSH_TTY: QR, no open', base({ env: { SSH_TTY: '/dev/pts/1' } }), {}, false, true],
    ['SSH_CLIENT: QR, no open', base({ env: { SSH_CLIENT: '1.2.3.4 1 22' } }), {}, false, true],
    ['Codespaces is a remote machine: QR, no open', linux({ DISPLAY: ':0', CODESPACES: 'true' }), {}, false, true],
    ['a dev container is remote: QR, no open', base({ env: { REMOTE_CONTAINERS: 'true' } }), {}, false, true],
    ['inside a container: QR, no open', linux({ DISPLAY: ':0' }, { inContainer: true }), {}, false, true],
    ['CI: neither', base({ env: { CI: 'true' } }), {}, false, false],
    ['GITHUB_ACTIONS: neither', base({ env: { GITHUB_ACTIONS: 'true' } }), {}, false, false],
    ['CI=false is not CI', base({ env: { CI: 'false' } }), {}, true, false],
    ['CI=0 is not CI', base({ env: { CI: '0' } }), {}, true, false],
    ['CI= (empty) is not CI', base({ env: { CI: '' } }), {}, true, false],
    ['--no-open at a terminal: no open, a QR instead', base(), { noOpen: true }, false, true],
    ['--qr at a terminal: QR, and no open', base(), { qr: true }, false, true],
    ['stdout is a pipe: neither (an agent relays the text)', base({ stdoutIsTTY: false }), {}, false, false],
    ['stdout is a pipe and --qr: the QR is forced, nothing opens', base({ stdoutIsTTY: false }), { qr: true }, false, true],
    ['stdin is a pipe but stdout a terminal: no open, QR', base({ stdinIsTTY: false }), {}, false, true],
    ['CI with --qr: the QR is forced', base({ env: { CI: 'true' } }), { qr: true }, false, true],
    ['--no-qr over SSH: no QR, no open', base({ env: { SSH_TTY: '/dev/pts/1' } }), { noQr: true }, false, false],
    ['--no-qr at a terminal still opens', base(), { noQr: true }, true, false],
    ['--no-qr beats --qr', base(), { qr: true, noQr: true }, false, false],
    ['--no-qr and --no-open: neither', base(), { noQr: true, noOpen: true }, false, false],
  ];
  it.each(rows)('%s', (_name, env, flags, open, qr) => {
    const plan = decideDelivery(env, flags);
    expect({ open: plan.open, qr: plan.qr }).toEqual({ open, qr });
    expect(plan.why.length).toBeGreaterThan(0);
  });
});

describe('browserLaunch on Windows: an absolute launcher, so a rundll32.exe in the working directory can never run', () => {
  const cmd = (env: Record<string, string | undefined>): string => browserLaunch('win32', LINK, env).command;
  it('is absolute and ends in System32\\rundll32.exe, built from SystemRoot', () => {
    expect(cmd({ SystemRoot: 'D:\\WINNT' })).toBe('D:\\WINNT\\System32\\rundll32.exe');
    expect(cmd({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\rundll32.exe');
  });
  it('falls back to C:\\Windows when SystemRoot is unset, empty or not absolute (a relative value would be the cwd again)', () => {
    for (const bad of [undefined, '', 'Windows', '.\\evil', '..\\x', 'System32']) expect(cmd({ SystemRoot: bad }), String(bad)).toBe('C:\\Windows\\System32\\rundll32.exe');
  });
  it('the other platforms are unaffected', () => {
    expect(browserLaunch('linux', LINK, { SystemRoot: 'D:\\x' }).command).toBe('xdg-open');
  });
});

describe('browserLaunch: one executable and an argument vector per OS, never a shell string', () => {
  it('macOS uses open, Linux xdg-open, Windows rundll32 (not cmd, not PowerShell)', () => {
    expect(browserLaunch('darwin', LINK)).toEqual({ command: 'open', args: [LINK] });
    expect(browserLaunch('linux', LINK)).toEqual({ command: 'xdg-open', args: [LINK] });
    expect(browserLaunch('win32', LINK, { SystemRoot: 'C:\\Windows' })).toEqual({ command: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', LINK] });
  });
  it('never names a shell, and never puts the link inside the command', () => {
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      const { command, args } = browserLaunch(p, LINK, { SystemRoot: 'C:\\Windows' });
      expect(command).toMatch(p === 'win32' ? /^C:\\Windows\\System32\\rundll32\.exe$/ : /^[a-z0-9-]+$/);
      expect(command).not.toMatch(/sh$|cmd|powershell|start/i);
      expect(args.filter((a) => a === LINK || a.endsWith(LINK))).toHaveLength(1);
      expect(args.every((a) => !/[;&|`$]/.test(a.replace(LINK, '')))).toBe(true);
    }
  });
});

function fakeSpawn(exit: number | 'error' | null = null) {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    child.pid = 1; child.unref = () => undefined;
    setTimeout(() => { if (exit === 'error') child.emit('error', new Error('ENOENT')); else if (exit !== null) child.emit('exit', exit); }, 0);
    return child;
  }) as never;
  return { calls, spawn };
}

describe('openApprovalLink: checks the link, then spawns with an argument vector', () => {
  it('spawns once with the link as ONE argument, no shell, detached, and reports success', async () => {
    const f = fakeSpawn(0);
    expect(await openApprovalLink(LINK, APP, { platform: 'linux', spawn: f.spawn, graceMs: 50 })).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.command).toBe('xdg-open');
    expect(f.calls[0]!.args).toEqual([LINK]);
    expect(Array.isArray(f.calls[0]!.args)).toBe(true);
    expect(f.calls[0]!.options['shell']).toBeFalsy();
    expect(f.calls[0]!.options['stdio']).toBe('ignore');
  });
  it('reports failure when the opener exits non-zero or cannot start', async () => {
    expect(await openApprovalLink(LINK, APP, { platform: 'linux', spawn: fakeSpawn(3).spawn, graceMs: 50 })).toBe(false);
    expect(await openApprovalLink(LINK, APP, { platform: 'linux', spawn: fakeSpawn('error').spawn, graceMs: 50 })).toBe(false);
  });
  it('never spawns for a link that fails the allowlist', async () => {
    const f = fakeSpawn(0);
    const evil = [`https://evil.example/share/approve/${ID}#k=${'B'.repeat(43)}`, `${LINK}"; calc`, `javascript:alert(1)`, LINK.replace('#k=', '?x=1#k='), `${LINK}\n`];
    for (const bad of evil) expect(await openApprovalLink(bad, APP, { platform: 'win32', spawn: f.spawn, graceMs: 20 })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it('spawn is called with an array even on Windows, where a string would be handed to a shell', async () => {
    const f = fakeSpawn(0);
    await openApprovalLink(LINK, APP, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, spawn: f.spawn, graceMs: 20 });
    expect(f.calls[0]).toMatchObject({ command: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', LINK] });
    expect(f.calls[0]!.options['windowsHide']).toBe(true);
  });
});
