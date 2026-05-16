/**
 * `toTypeScript()` — DEPRECATED.
 *
 * This package (`@lumenize/ts-runtime-validator`) is deprecated — see the
 * README banner. It was superseded by `@lumenize/ts-runtime-parser-validator`.
 *
 * The original implementation walked the tuple `{ root, objects[] }`
 * intermediate format from `@lumenize/structured-clone`. On 2026-05-16 that
 * package switched to the W4 `{ json, meta }` shape (see
 * `tasks/structured-clone-object-based-wire-format.md`), so the walker would
 * need a full rewrite to function. Since no internal consumer imports from
 * this package, we leave it as a stub that throws with a clear migration
 * message rather than carrying ~400 LOC of dead-end maintenance burden.
 *
 * The legacy walker is preserved in git history at HEAD before commit
 * touching this file post-2026-05-16; recover it with `git log -- this file`
 * if needed for a future migration.
 */

/**
 * @deprecated Use `@lumenize/ts-runtime-parser-validator` instead.
 *
 * @throws Always. This function is no longer functional under the post-2026-05-16
 * `@lumenize/structured-clone` wire format. See README for migration path.
 */
export function toTypeScript(
  _value: unknown,
  _typeName: string,
  _typeParams?: Record<string, string>,
): string {
  throw new Error(
    '@lumenize/ts-runtime-validator is deprecated and is not compatible ' +
    'with @lumenize/structured-clone\'s post-2026-05-16 wire format. ' +
    'Migrate to @lumenize/ts-runtime-parser-validator. ' +
    'See packages/ts-runtime-validator/README.md.',
  );
}
