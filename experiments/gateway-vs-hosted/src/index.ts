/**
 * The experiment's Worker: routes a client's socket to its own Gateway (arm A) or straight to the
 * BenchDO (arm B). Both arms pay the same Worker cost per upgrade and none per call.
 *
 *   /s/{runId}/gateway/LUMENIZE_CLIENT_GATEWAY/{sub}.{tabId}  → that client's Gateway
 *   /s/{runId}/gateway/BENCH_DO/{sub}.{tabId}                 → BenchDO `{runId}`, holding the socket
 *
 * `LumenizeClient` builds the tail of each URL from its `baseUrl` (`…/s/{runId}`), its
 * `gatewayBindingName` and its `instanceName`, so one unmodified client class drives both arms.
 *
 * The upgrade gate is a shared secret inside the token, not a signature: per-call cost is what is
 * measured, and the token is checked only at the upgrade in both arms. It exists so a public
 * `workers.dev` URL cannot be used to run up this account's bill while the experiment is deployed.
 */
import { LumenizeClientGateway } from '@lumenize/mesh';
import { WS_TOKEN_PREFIX } from '@lumenize/mesh/client';

export { LumenizeClientGateway };
export { BenchDO } from './bench-do';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    const match = url.pathname.match(/^\/s\/([\w-]+)\/gateway\/(LUMENIZE_CLIENT_GATEWAY|BENCH_DO)\/([\w.-]+)$/);
    if (!match) return new Response('Not Found', { status: 404 });
    const [, runId, binding, clientInstance] = match;

    const token = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
      .split(',').map((p) => p.trim()).find((p) => p.startsWith(WS_TOKEN_PREFIX))?.slice(WS_TOKEN_PREFIX.length);
    const benchToken = (env as unknown as Record<string, string | undefined>).BENCH_TOKEN;
    if (!token || !benchToken || readPayload(token)?.bench !== benchToken) {
      return new Response('Unauthorized', { status: 401 });
    }

    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Lumenize-DO-Binding-Name', binding);
    let stub: DurableObjectStub;
    if (binding === 'LUMENIZE_CLIENT_GATEWAY') {
      headers.set('X-Lumenize-DO-Instance-Name-Or-Id', clientInstance);
      stub = env.LUMENIZE_CLIENT_GATEWAY.getByName(clientInstance);
    } else {
      headers.set('X-Lumenize-DO-Instance-Name-Or-Id', runId);
      headers.set('X-Bench-Client', clientInstance);
      stub = env.BENCH_DO.getByName(runId);
    }
    return stub.fetch(new Request(request.url, { method: request.method, headers }));
  },
};

function readPayload(token: string): Record<string, unknown> | undefined {
  try {
    const b64 = token.split('.')[1];
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return undefined;
  }
}
