// Makes `env` / `SELF` from `cloudflare:test` carry this worker's generated bindings.
// The `/// <reference>` is required as of pool-workers 0.14+ (the cloudflare:test module
// declaration lives at the `/types` subpath). A real file here (not the monorepo symlink)
// because this experiment is deliberately NOT a workspace member.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
