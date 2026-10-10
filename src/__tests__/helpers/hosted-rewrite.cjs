/* global process, URL */
// Test-only preload: a fetch to Align's hosted gateway goes to the loopback fake named by ALIGN_TEST_HOSTED_REWRITE.
// The product only prompts for the hosted URL, so this is how a loopback test reaches the prompt without a product seam.
const real = globalThis.fetch;
const HOSTED = 'https://api.align.tech';
globalThis.fetch = (input, init) => {
  const to = process.env.ALIGN_TEST_HOSTED_REWRITE;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (to && url.startsWith(HOSTED)) return real(to + url.slice(HOSTED.length), init);
  return real(input, init);
};
