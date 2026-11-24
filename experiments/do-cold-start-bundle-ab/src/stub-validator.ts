/**
 * Stand-in for `@lumenize/ts-runtime-parser-validator`, substituted at bundle time via
 * wrangler's `--alias`. Used by the `nebula-lite` arm ONLY.
 *
 * WHY. The gap in the size curve (684 KiB → 9.2 MB) is unsampled, and removing the validator
 * from apps/nebula would land the worker at ~2.6 MB — squarely inside it. Rather than
 * approximating that with a pile of unrelated packages, this aliases the validator out of a
 * REAL `@lumenize/nebula` import, producing a faithful "nebula minus validator" bundle: the
 * exact shape the post-refactor worker would have.
 *
 * These are every VALUE export apps/nebula imports from that package (`ParserValidator` and
 * `TypeMetadata` are type-only and erase at build). Three of the four are the tsc-dependent
 * build functions; only `getParserValidatorFacet` is on the request path, and it's a thin
 * Worker Loader wrapper — which is the whole reason the split is viable.
 *
 * They throw rather than no-op: this arm only ever calls `echo`, so any call means the
 * experiment drifted from what it claims to measure and should fail loudly.
 */

const aliasedOut =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`stub-validator: ${name}() is aliased out in the nebula-lite arm`);
  };

export const checkTypeScript = aliasedOut('checkTypeScript');
export const generateParseModule = aliasedOut('generateParseModule');
export const getParserValidatorFacet = aliasedOut('getParserValidatorFacet');
export const extractTypeMetadata = aliasedOut('extractTypeMetadata');
