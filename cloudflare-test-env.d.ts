// Augment cloudflare:test module to use the auto-generated Env type.
// This file is symlinked to packages that use @cloudflare/vitest-pool-workers.
// It makes 'env' from 'cloudflare:test' imports have the correct bindings.
//
// The `/// <reference>` is required as of pool-workers 0.14+: the cloudflare:test
// module declaration moved to the `/types` subpath. Without this reference,
// `import { env } from 'cloudflare:test'` fails with "no exported member 'env'".
/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

