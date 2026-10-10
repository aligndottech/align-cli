/* global process */
// Preloaded into a CHILD to make Node report darwin, so env-paths picks ~/Library/... exactly as on macOS.
// Only a path-layout simulation: it proves a fixture uses the product's path helper, it is not macOS.
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
