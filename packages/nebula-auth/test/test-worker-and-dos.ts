/**
 * Test worker that exports DO classes for wrangler bindings.
 *
 * Phase 1: Stub DOs — just enough for wrangler to create instances.
 * Real implementations come in Phase 2 (NebulaAuth) and Phase 6 (NebulaAuthRegistry).
 */
import { DurableObject } from 'cloudflare:workers';

export class NebulaAuth extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response('NebulaAuth stub', { status: 501 });
  }
}

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
