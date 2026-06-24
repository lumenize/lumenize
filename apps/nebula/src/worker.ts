/**
 * Assembled-Worker entry — the `main` in `wrangler.jsonc` for `wrangler dev` / deploy.
 *
 * Re-exports the default `fetch` handler (the {@link entrypoint}) PLUS every Durable
 * Object class the `wrangler.jsonc` `durable_objects.bindings` reference, so the
 * runtime can locate each class by name, PLUS the `NebulaEmailSender` WorkerEntrypoint
 * the `AUTH_EMAIL_SENDER` service binding targets (magic-link / invite email). The
 * platform DOs come from this package (`./index`); the auth DOs + email sender come
 * from `@lumenize/nebula-auth`. Mirrors the proven baseline test-app wiring
 * (`test/test-apps/baseline/index.ts`).
 *
 * NOTE: separate from `src/index.ts` (the library surface, which exports `entrypoint`
 * as a NAMED export + omits the nebula-auth DOs) — wrangler needs a `default` handler
 * and every bound class re-exported from one module.
 */
export { default } from './entrypoint';
export {
  NebulaClientGateway,
  Universe,
  Galaxy,
  Star,
  DevStudio,
  DevContainer,
} from './index';
export { NebulaAuth, NebulaAuthRegistry, NebulaEmailSender } from '@lumenize/nebula-auth';
