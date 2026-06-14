/**
 * e2e test-harness Worker entry — placeholder.
 *
 * The ported harness will re-export the Nebula DO stack (NebulaClientGateway,
 * Universe, Galaxy, Star, ResourceHistory, NebulaAuth, NebulaAuthRegistry) and
 * the email sender so vitest-pool-workers can drive a real Star, mirroring
 * apps/nebula/spike/vue-factory/test/test-harness.ts. Until the e2e suites land
 * (Phase 5.3.7-v3) this is a minimal valid Worker so the e2e project's wrangler
 * config loads.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response('nebula-frontend e2e harness placeholder');
  },
};
