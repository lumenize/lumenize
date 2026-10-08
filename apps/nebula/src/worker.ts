/**
 * Assembled-Worker entry — the `main` in `wrangler.jsonc` for `wrangler dev` / deploy.
 *
 * Re-exports the default `fetch` handler (the {@link entrypoint}) PLUS every Durable
 * Object class the `wrangler.jsonc` `durable_objects.bindings` reference, so the
 * runtime can locate each class by name, PLUS the `AuthEmailSender` WorkerEntrypoint
 * the `AUTH_EMAIL_SENDER` service binding targets (magic-link / invite email). The
 * platform DOs come from this package (`./index`); the auth DOs + email sender come
 * from `@lumenize/mesh/auth`. Mirrors the proven baseline test-app wiring
 * (`test/test-apps/baseline/index.ts`).
 *
 * NOTE: separate from `src/index.ts` (the library surface, which exports `entrypoint`
 * as a NAMED export + omits the nebula-auth DOs) — wrangler needs a `default` handler
 * and every bound class re-exported from one module.
 */
export { default } from './entrypoint';
export {
  Universe,
  Galaxy,
  Star,
  NebulaAuthFacade,
  PlatformHost,
} from './index';
export { AuthRegistry, AuthEmailSender } from '@lumenize/mesh/auth';
export { Profile } from '@lumenize/mesh/auth/profile';
// The @cloudflare/computer loopback WorkerEntrypoint — the container backend routes
// computerd's container→DO traffic through `ctx.exports.WorkspaceProxy`, which only
// resolves when the class is exported from the Worker's main module.
export { WorkspaceProxy } from '@cloudflare/computer';
