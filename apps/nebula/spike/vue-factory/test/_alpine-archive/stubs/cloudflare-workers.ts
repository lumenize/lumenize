/**
 * Stub for `cloudflare:workers` used only by vite's import-analysis pass.
 *
 * `@lumenize/debug` does `await import('cloudflare:workers')` in a try/catch
 * — works correctly at runtime in Node/browser (the dynamic import throws,
 * catch swallows). But vite's bundler scans the literal specifier ahead of
 * time and fails. resolve.alias maps it here.
 *
 * Proper fix: configure `@lumenize/debug` to be browser-bundler-safe (see
 * task file Phase -1 § 7). Until then, downstream packages need this stub.
 */
export const env = undefined;
