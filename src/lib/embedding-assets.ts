/**
 * Everything the on-device embedding path pins: which native runtime, which model files, where
 * each comes from, and the SHA-256 each must hash to.
 *
 * Single source of truth. The loader (embedding-runtime.ts, local-embeddings-native.ts), the
 * release-asset builder (scripts/build-ort-runtime.ts) and `align doctor` all read this file, so
 * the digest the CLI trusts and the digest the workflow publishes cannot drift apart.
 *
 * WHY A DOWNLOAD AT ALL (ALI-1781). `@huggingface/transformers` depends on `onnxruntime-node`,
 * whose npm tarball carries the runtime for EVERY OS and the CUDA/TensorRT providers (548MB
 * installed), plus `onnxruntime-web` (141MB, browser) and `sharp` - 779MB for a CLI whose
 * embeddings need ~46MB of one platform's CPU library. npm has no way to install one platform's
 * slice of a single package, and an `overrides` entry in this package is ignored when it is
 * installed globally. So the runtime for THIS os/arch is fetched once, on first local use, and
 * the digest below is what makes that safe.
 */
import { join } from 'node:path';

/** onnxruntime-node release the bundle is cut from. This is the version a plain
 *  `npm install @aligndottech/cli` resolved when the vectors in existing graphs were written. */
export const ORT_VERSION = '1.30.0';

/** npm `dist.integrity` of the two upstream tarballs the bundles are built from. */
export const ORT_NODE_NPM_INTEGRITY =
  'sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==';
export const ORT_COMMON_NPM_INTEGRITY =
  'sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==';

/**
 * SHA-256 of the UNCOMPRESSED tar for each platform (see tar-lite.ts: the tar is
 * reproducible, the gzip around it is not). Filled in by `npx tsx scripts/build-ort-runtime.ts`.
 * A platform absent here has no runtime bundle, which is the same set `transformers.js` ran on
 * before: glibc Linux x64/arm64, macOS arm64, Windows x64/arm64.
 */
export const RUNTIME_SHA256: Readonly<Record<string, string>> = {
  'linux-x64': '8b9fd63b63d9a67c7008b0a54b2f2e18638f473bc6f01cdd777e7e3614a74cd3',
  'linux-arm64': '85961209b62e6bc301be1596f7019f7c2a632d955ce94799bf298ed713ff8e14',
  'darwin-arm64': '75da7e3e9dbffaaaabaafe6ca44f4e1afaa00e81cda298d11fc965edccc7f972',
  'win32-x64': 'dbc1f3a9c90f9def839ac19f2e5f35c60013e164bdfa8b4b90bb87bc40eaa636',
  'win32-arm64': 'c3f98d500b86aede9bc554e491d6f69c141fd6a497120e2da89a36cb0283bc2b',
};

export function runtimeKey(platform: string = process.platform, arch: string = process.arch, table: Readonly<Record<string, string>> = RUNTIME_SHA256): string | null {
  const key = `${platform}-${arch}`;
  return key in table ? key : null;
}

export const RUNTIME_TAG = `ort-runtime-v${ORT_VERSION}`;
export const RUNTIME_DEFAULT_BASE_URL = `https://github.com/aligndottech/align-cli/releases/download/${RUNTIME_TAG}`;

export function runtimeAssetName(key: string): string {
  return `align-ort-${ORT_VERSION}-${key}.tgz`;
}

/** `ALIGN_ORT_RUNTIME_URL` points at a mirror or a pre-staged directory (https:, http: or
 *  file:). It changes WHERE the bytes come from and nothing about what they must hash to. */
export function runtimeUrl(key: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env['ALIGN_ORT_RUNTIME_URL'] || RUNTIME_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/${runtimeAssetName(key)}`;
}

/** Upper bounds for the extracted runtime. The real figures are ~46MB for the biggest bundle. */
export const RUNTIME_LIMITS = { maxEntries: 200, maxTotalBytes: 160 * 1024 * 1024 } as const;

export const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
/** Immutable commit of the model repo; files are fetched by commit, never by `main`. */
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';

export interface ModelFile { path: string; sha256: string; maxBytes: number }

/** Same three files transformers.js fetched for dtype q8 (config.json is not read by us). */
export const MODEL_FILES: readonly ModelFile[] = [
  { path: 'onnx/model_quantized.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', maxBytes: 40 * 1024 * 1024 },
  { path: 'tokenizer.json', sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0', maxBytes: 4 * 1024 * 1024 },
  { path: 'tokenizer_config.json', sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3', maxBytes: 64 * 1024 },
];

/** `HF_ENDPOINT` is the convention huggingface tooling uses for a mirror. Digest still applies. */
export function modelFileUrl(file: ModelFile, env: Record<string, string | undefined> = process.env): string {
  const host = (env['HF_ENDPOINT'] || 'https://huggingface.co').replace(/\/+$/, '');
  return `${host}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file.path}`;
}

export function runtimeDir(root: string, key: string): string {
  return join(root, 'ort', `${ORT_VERSION}-${key}`);
}

export function modelDir(root: string): string {
  return join(root, 'hf', ...MODEL_REPO.split('/'), MODEL_REVISION.slice(0, 12));
}
