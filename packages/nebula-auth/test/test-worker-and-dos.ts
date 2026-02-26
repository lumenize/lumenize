/**
 * Test worker entry point — exports DO classes and default fetch handler
 * for wrangler bindings. Lives next to test/wrangler.jsonc.
 */
import { routeNebulaAuthRequest } from '../src/router';

// Re-export DO classes for wrangler bindings
export { NebulaAuth } from '../src/nebula-auth';
export { NebulaAuthRegistry } from '../src/nebula-auth-registry';

// Email sender service binding entrypoint
export { NebulaEmailSender } from '../src/nebula-email-sender';

// Default Worker export — test-only, not part of the library's public API
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return routeNebulaAuthRequest(request, env);
  },
};
