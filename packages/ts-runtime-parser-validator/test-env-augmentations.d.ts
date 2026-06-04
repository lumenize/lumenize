/**
 * Augments the package-level `Env` type with bindings declared in test
 * subdir `wrangler.jsonc` files.
 *
 * Needed because the package's `tsc -p` invocation (used by
 * `npm run type-check`) doesn't resolve subdir bindings through the
 * auto-generated `worker-configuration.d.ts` files at the test subdirs —
 * interface merging across the full ~12k-line generated files in two
 * locations seems to drop the subdir-specific entries (observed
 * 2026-06-02). A small explicit augmentation here at the package root
 * merges cleanly and is git-tracked (subdir `**\/test/**\/*.d.ts` is
 * gitignored to prevent stale compiled artifacts).
 *
 * vitest-pool-workers at test runtime sees the right bindings via the
 * local per-subdir `worker-configuration.d.ts`; this file is purely for
 * the package-level `tsc -p` check.
 */

declare namespace Cloudflare {
  interface Env {
    SUPERVISOR: DurableObjectNamespace<
      import('./test/for-docs/getting-started').SupervisorDO
    >;
  }
}
