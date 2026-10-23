import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // Bundled apps: rrweb stays an external dependency behind a dynamic
    // import(), so the app's bundler puts it in a lazy chunk (or drops it
    // from the critical path) and dedupes it with any other rrweb copy.
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    splitting: true,
    external: ['rrweb'],
    esbuildOptions(options) {
      options.chunkNames = '[name]-[hash]'
    },
  },
  {
    // Script tag: no bundler on the host page, so rrweb is bundled into a
    // separate chunk that auto.js fetches only when replay starts.
    entry: ['src/auto.ts'],
    format: ['esm'],
    dts: true,
    splitting: true,
    minify: true,
    noExternal: ['rrweb'],
    esbuildOptions(options) {
      options.chunkNames = 'auto-[name]-[hash]'
    },
  },
])
