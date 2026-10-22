/**
 * The only module that touches rrweb. It is reached through a dynamic
 * `import()` in replay.ts, so rrweb never lands in the main bundle, and the
 * named re-export lets bundlers drop rrweb's player from the lazy chunk.
 */
export { record } from 'rrweb'
