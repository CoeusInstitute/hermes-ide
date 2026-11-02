// Build-time names (dev/build.mjs), for editors and type checkers.

/** True in the catalog build (the default), false in the full build. esbuild replaces it with a
 *  literal, so the other build's branches are removed from the bundle, not just skipped. */
declare const __CATALOG__: boolean

/** The editor iframe's markup: styles plus #empty, #editor and #menu, no script. */
declare module 'virtual:frame-html' {
  const html: string
  export default html
}
