import { createRouteDORequestAuthHooks } from './hooks';

/**
 * Target for routing an authenticated request to a Durable Object.
 */
interface DOTarget {
  /** The DO namespace binding from `c.env` (e.g., `c.env.MY_DO`) */
  doNamespace: DurableObjectNamespace;
  /** The DO instance name or ID (e.g., `c.req.param('id')` or `'default'`) */
  doInstanceNameOrId: string;
}

/**
 * Creates a Hono route handler that authenticates requests (HTTP and WebSocket)
 * and forwards them to a Durable Object.
 *
 * Combines `createRouteDORequestAuthHooks` with DO dispatch into a single handler.
 * Automatically selects the correct hook based on the request type:
 * - HTTP requests: verifies `Authorization: Bearer` header via `onBeforeRequest`
 * - WebSocket upgrades: verifies token in `Sec-WebSocket-Protocol` via `onBeforeConnect`
 *
 * The resolver function receives the Hono context and returns the target DO namespace
 * and instance. This is called on every request, so you can use route params.
 *
 * @example
 * ```typescript
 * import { honoAuthMiddleware } from '@lumenize/auth';
 *
 * app.all('/api/:id/*?', honoAuthMiddleware((c) => ({
 *   doNamespace: c.env.MY_DO,
 *   doInstanceNameOrId: c.req.param('id'),
 * })));
 * ```
 *
 * @param resolveTarget - Function that extracts the DO target from the Hono context
 * @returns A Hono route handler (use with `app.all`, `app.get`, etc.)
 *
 * @see https://lumenize.com/docs/auth/hono
 */
export function honoAuthMiddleware(
  resolveTarget: (c: any) => DOTarget,
) {
  let hooksPromise: ReturnType<typeof createRouteDORequestAuthHooks> | null = null;

  return async (c: any): Promise<Response> => {
    const { doNamespace, doInstanceNameOrId } = resolveTarget(c);

    // Lazy-init hooks once per isolate (they capture keys + config in closure)
    if (!hooksPromise) {
      hooksPromise = createRouteDORequestAuthHooks(c.env);
    }
    const hooks = await hooksPromise;

    // Pick hook based on upgrade header
    const isWebSocket = c.req.header('Upgrade') === 'websocket';
    const hook = isWebSocket ? hooks.onBeforeConnect : hooks.onBeforeRequest;

    const result = await hook(c.req.raw, { doNamespace, doInstanceNameOrId });
    if (result instanceof Response) return result;

    // Forward enhanced request to DO
    const stub = doNamespace.get(doNamespace.idFromName(doInstanceNameOrId));
    return stub.fetch(result ?? c.req.raw);
  };
}
