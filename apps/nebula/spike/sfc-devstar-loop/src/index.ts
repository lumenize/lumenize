import { routeDORequest } from '@lumenize/routing';

export { SpikeGalaxy } from './galaxy';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route /galaxy/{instanceName}/* to the Galaxy DO.
    // Spike URL conventions:
    //   wss://.../galaxy/spike/reload/{sessionId}      — WS upgrade (preview client)
    //   https://.../galaxy/spike/compile/{sessionId}   — POST SFC source (trigger compile+notify)
    //
    // Standalone spike — no prefix. Production integration into apps/nebula
    // would gain a prefix (likely /dev) to distinguish dev-mode routes from
    // existing NebulaGateway routes. Also, in production the Studio client
    // would call Galaxy.compile() via mesh `lmz.call`, not via a /compile
    // POST endpoint — only the WS upgrade route would survive in production.
    const response = await routeDORequest(request, env);
    if (response) return response;

    return new Response('Not found — SFC Galaxy spike\nTry /galaxy/spike/{action}/{sessionId}', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    });
  },
} satisfies ExportedHandler<Env>;
