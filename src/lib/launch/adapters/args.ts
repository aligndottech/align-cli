/**
 * The user's pass-through args first, our flags last, with one exception: a literal `--` in the
 * pass-through ends option parsing, so a flag placed after it would be read as a message or a
 * file. Our flags go just before it.
 */
export function withInjectedFlags(passthrough: string[], injected: string[]): string[] {
  const sep = passthrough.indexOf('--');
  return sep < 0 ? [...passthrough, ...injected] : [...passthrough.slice(0, sep), ...injected, ...passthrough.slice(sep)];
}
