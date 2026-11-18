/* global URL */
// Test-only preload, put on NODE_OPTIONS by vitest.config.ts: a child process a test spawns cannot reach the hosted
// gateway. isolated-home.setup.ts guards the test process itself; this guards the CLIs it starts. Same origins and the
// same message, so one assertion covers both (tests-never-reach-hosted-gateway.test.ts).
const HOSTED_ORIGINS = ['https://api.align.tech', 'https://api.preview.align.tech'];
const real = globalThis.fetch;
if (real) {
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (HOSTED_ORIGINS.some((o) => url === o || url.startsWith(`${o}/`))) {
      return Promise.reject(new TypeError(`the hosted gateway is blocked in tests: ${url}`));
    }
    return real(input, init);
  };
}
