// Indirection point for the package.json "browser" field. When bun builds
// browser-sdk.js with --target browser, this file is swapped for
// crypto.browser.ts — avoiding a ~500KB crypto-browserify polyfill that Bun
// would otherwise inline for `import ... from 'crypto'`. Node/bun builds use
// this file unchanged and rely on the global `crypto.randomUUID()` API
// available in both Bun and modern Node.js (>= 19).
export const randomUUID = () => crypto.randomUUID()
