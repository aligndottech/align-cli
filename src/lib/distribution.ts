/**
 * How this copy of the CLI was distributed.
 *
 * Not a runtime guess. `scripts/build-binaries.sh` passes `--define __ALIGN_DIST__='"binary"'`
 * to `bun build --compile`, so the answer is decided at build time by the thing that actually
 * knows it. Sniffing `process.versions.bun` or an `import.meta.url` starting with `/$bunfs/`
 * would be inferring a fact that is already available (latent-vs-deterministic.md: if a
 * question has one right answer, compute it from a named input).
 *
 * `typeof` rather than a bare read: under npm the identifier is never declared at all, and a
 * bare reference would be a ReferenceError rather than the default.
 */
declare const __ALIGN_DIST__: string | undefined;

export type Distribution = 'npm' | 'binary';

export function alignDistribution(): Distribution {
  return typeof __ALIGN_DIST__ !== 'undefined' && __ALIGN_DIST__ === 'binary' ? 'binary' : 'npm';
}
