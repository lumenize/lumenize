// Augment cloudflare:test module to use the auto-generated Env type
// This file is symlinked to packages that use @cloudflare/vitest-plugin
// It makes 'env' from 'cloudflare:test' imports have the correct bindings
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

