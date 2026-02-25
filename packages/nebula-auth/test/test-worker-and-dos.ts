/**
 * Test worker that exports DO classes for wrangler bindings.
 *
 * Phase 4: Both NebulaAuth and NebulaAuthRegistry are real.
 */

// Re-export the real DO classes
export { NebulaAuth } from '../src/nebula-auth';
export { NebulaAuthRegistry } from '../src/nebula-auth-registry';

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('Not Found', { status: 404 });
  },
};
