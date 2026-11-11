/**
 * In-memory stand-ins for the three OS credential tools, behind the injected `Run`. No test
 * may reach a real keychain: these parse the argv/stdin the real tool would get and keep the
 * secrets in a Map. Every call is recorded so a test can assert a secret never reached argv.
 */
import type { Run, RunResult } from '../../lib/token-store.js';

/** A line `security -i` is assumed to accept. The real limit is unknown; 1024 is the strictest plausible one. */
export const MAC_LINE_LIMIT = 1024;

export interface Call { cmd: string; args: string[]; input: string | undefined; timeoutMs: number | undefined }
export interface FakeTool {
  run: Run;
  calls: Call[];
  /** account -> secret, as the OS would hold it. */
  store: Map<string, string>;
  /** Make every call fail like a tool that is missing or has no service behind it. */
  breakIt(stderr?: string): void;
  /** Undo breakIt: the tool works again (a new vault is needed to see it: a vault stops asking after its first failure). */
  fix(): void;
  /** Writes fail the way `security -i` does on a parse error: the command line, secret included, comes back on stderr. */
  echoWrites(): void;
  /** Accept writes (exit 0) but store nothing, like `security -i` reporting success on a failed command. */
  swallowWrites(): void;
}

const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
const fail = (status: number, stderr = ''): RunResult => ({ status, stdout: '', stderr });

export function fakeTool(kind: 'security' | 'secret-tool' | 'powershell'): FakeTool {
  const calls: Call[] = [];
  const store = new Map<string, string>();
  let broken: string | null = null;
  let swallow = false;
  let echo = false;
  const run: Run = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input, timeoutMs: opts?.timeoutMs });
    if (broken !== null) return fail(127, broken);
    if (echo && opts?.input !== undefined) return fail(1, `parse error near: ${opts.input}`);
    if (kind === 'security') return security(args, opts?.input ?? '');
    if (kind === 'secret-tool') return secretTool(args, opts?.input ?? '');
    return powershell(args, opts?.input ?? '');
  };
  const security = (args: string[], input: string): RunResult => {
    if (args[0] === '-i') {
      // Interactive mode: the command line arrives on stdin, and a failure still exits 0.
      // The real tool reads a bounded line: past it, the rest of the line is parsed as the NEXT command (seen on macOS with a 3,000 character token).
      for (const l of input.split('\n')) {
        if (l.length > MAC_LINE_LIMIT) return fail(1, `security: unknown command "${l.slice(MAC_LINE_LIMIT)}"`);
      }
      const m = /^add-generic-password -U -a "([^"]+)" -s "align-cli" -X ([0-9a-f]+)$/m.exec(input);
      if (m && !swallow) store.set(m[1]!, Buffer.from(m[2]!, 'hex').toString('utf8'));
      return ok();
    }
    if (args[0] === 'list-keychains') return ok('"/Users/x/Library/Keychains/login.keychain-db"');
    const acct = args[args.indexOf('-a') + 1]!;
    if (args[0] === 'find-generic-password') return store.has(acct) ? ok(`${store.get(acct)!}\n`) : fail(44, 'could not be found');
    if (args[0] === 'delete-generic-password') return store.delete(acct) ? ok() : fail(44, 'could not be found');
    return fail(1, 'usage');
  };
  const secretTool = (args: string[], input: string): RunResult => {
    const acct = args[args.indexOf('account') + 1]!;
    if (args[0] === 'store') { if (!swallow) store.set(acct, input); return ok(); }
    if (args[0] === 'lookup') return store.has(acct) ? ok(store.get(acct)!) : fail(1);
    if (args[0] === 'clear') { store.delete(acct); return ok(); }
    return fail(2, 'usage');
  };
  // "DPAPI": the blob is a reversible stand-in so a test can tell plaintext from protected.
  const powershell = (_args: string[], input: string): RunResult => {
    const script = _args[_args.length - 1] ?? '';
    if (script.includes('ConvertFrom-SecureString')) return swallow ? ok('') : ok(`DPAPI-${Buffer.from(input.replace(/[\r\n]+$/, '')).toString('hex')}`);
    if (script.includes('PtrToStringBSTR')) {
      const blob = input.trim();
      return blob.startsWith('DPAPI-') ? ok(Buffer.from(blob.slice(6), 'hex').toString('utf8')) : fail(1, 'bad blob');
    }
    return ok(); // the availability probe
  };
  return { run, calls, store, breakIt: (s = 'tool missing') => { broken = s; }, fix: () => { broken = null; }, echoWrites: () => { echo = true; }, swallowWrites: () => { swallow = true; } };
}
