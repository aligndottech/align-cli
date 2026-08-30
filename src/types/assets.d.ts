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

/**
 * The transformers WEB build, imported by path from src/lib/local-embeddings-wasm.ts.
 *
 * The package's own types describe the NODE entry; the web dist has no declaration file, so
 * without this the dynamic import is an implicit `any` and every property access on it is
 * unchecked. Only the two members that module uses are declared - a wider guess would be
 * asserting things about a dependency nobody has verified.
 */
declare module '*/transformers.web.js' {
  export const env: Record<string, unknown>;
  export function pipeline(
    task: string,
    model: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
}
