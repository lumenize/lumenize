/**
 * Test worker that exports DO classes for wrangler bindings.
 *
 * Phase 2: NebulaAuth is real, NebulaAuthRegistry is still a stub (Phase 6).
 */
import { DurableObject } from 'cloudflare:workers';

// Re-export the real NebulaAuth DO
export { NebulaAuth } from '../src/nebula-auth';

export class NebulaAuthRegistry extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response('NebulaAuthRegistry stub', { status: 501 });
  }
}

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('Not Found', { status: 404 });
  }
};
