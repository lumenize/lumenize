/**
 * Container-node test-app worker (stub).
 *
 * This project's tests are all PURE / prototype-level — NebulaContainer `extends Container`,
 * which can't be constructed under vitest-pool-workers. The scope-isolation guard is tested by
 * driving `NebulaContainer.onBeforeCall` on a fake `this` (nebula-container.test.ts); the
 * cloud-only stuck-flag signature predicates are pure functions (stuck-signature.test.ts). So
 * no Durable Object is registered here — just a stub worker so the project has an entry point.
 * Not in `npm test`; run with `npx vitest run --project container`.
 * (NebulaContainer itself is orphaned by the Galaxy collapse and retires in its cleanup phase.)
 */
export default {
  fetch(): Response {
    return new Response('nebula container-node test app');
  },
};
