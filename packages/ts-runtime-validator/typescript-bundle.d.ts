// Ambient module declaration for the pre-bundled TypeScript compiler.
//
// `dist/typescript.bundled.mjs` is a build artifact (per the
// `typescript-bundling-pattern` constraint: typescript npm must be
// pre-bundled for Workers). The dist tree is gitignored, so the natural
// sibling `.d.mts` next to the bundle wouldn't survive a fresh clone.
// Ambient `declare module` with a glob lives at the package root instead
// and matches the import regardless of where the bundle physically lives.
// Typed as `any` — the bundle's full type surface is the entire TypeScript
// API, and `@lumenize/ts-runtime-validator` is deprecated in favor of
// `@lumenize/ts-runtime-parser-validator`, so the cost of a stricter
// declaration isn't justified.

declare module '*/typescript.bundled.mjs' {
  const ts: any;
  export default ts;
}
