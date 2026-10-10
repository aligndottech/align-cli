/**
 * L9: ask a person a yes/no question on their CONTROLLING terminal, and prove it is one.
 *
 * Why not stdin: an agent's shell tool, a hook and a pipe all own stdin, so a "yes" read there proves
 * nothing. `/dev/tty` (`CONIN$`/`CONOUT$` on Windows) is the terminal the process was started from; a
 * process with no controlling terminal (a daemon, a `setsid` child, most agent shells) cannot open it.
 * The handle must also pass `tty.isatty`: on Windows an open of CONIN$ can succeed against something
 * that is not an interactive console, and "cannot prove it" means refuse, never block.
 *
 * The text a person must read is written to the SAME terminal just before the question, so it is the
 * thing they see even when stdout is a pipe or a file. Returns true/false for y/n (default No, and end
 * of input is No), or null when there is no interactive terminal. Honest limit, stated in SECURITY.md:
 * a caller that allocates its own pseudo-terminal can type the answer; no local CLI can stop that.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import tty from 'node:tty';

export type TtyPaths = readonly [input: string, output: string];
export const TTY_PATHS: TtyPaths = process.platform === 'win32' ? ['CONIN$', 'CONOUT$'] : ['/dev/tty', '/dev/tty'];

export async function ttyConfirm(shown: string, question: string, paths: TtyPaths = TTY_PATHS): Promise<boolean | null> {
  let inFd = -1;
  let outFd = -1;
  try {
    inFd = fs.openSync(paths[0], 'r');
    outFd = fs.openSync(paths[1], 'w');
    if (!tty.isatty(inFd) || !tty.isatty(outFd)) throw new Error('not an interactive terminal');
  } catch {
    for (const fd of [inFd, outFd]) if (fd >= 0) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    return null;
  }
  // The tty streams own their descriptors from here: destroying them closes the fds, so no
  // fs.closeSync of ours can race a readline that is still reading (the EBADF the review found).
  const input = new tty.ReadStream(inFd);
  const output = new tty.WriteStream(outFd);
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    output.write(`${shown}\n\n`);
    const answer = await new Promise<string>((resolve) => {
      rl.once('close', () => resolve(''));
      rl.question(`${question} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
    input.destroy();
    output.destroy();
  }
}
