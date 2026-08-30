/**
 * `bun build --compile` embeds a file imported with `{ type: 'file' }` and hands back a real
 * path at runtime (under /$bunfs/), readable with node:fs. tsc has no idea what a .wasm or a
 * vendored .mjs is, so declare them as the path strings Bun makes them.
 *
 * Only src/lib/local-embeddings-wasm.ts uses these, and only the binary build compiles it.
 */
declare module '*.wasm' {
  const path: string;
  export default path;
}
declare module '*.mjs' {
  const path: string;
  export default path;
}
