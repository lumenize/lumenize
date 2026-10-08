import { debug } from '@lumenize/debug';
import { routeDORequest } from '@lumenize/routing';
import { extractWebSocketToken } from '../gateway-messages';
import { GATEWAY_PREFIX } from '../scoped-mesh-do';
import { parseId } from './parse-id';
import { verifyAccessToken } from './router';
import type { AuthClaims, Tier } from './types';

/** The binding of the node each tier of scope names: `{ universe: 'UNIVERSE', galaxy: 'GALAXY', star: 'STAR' }`. */
export type TierBindings = Readonly<Record<Tier, string>>;

/** The token an upgrade carries in its subprotocol, verified, or the refusal. */
async function verifiedUpgradeToken(request: Request, env: Env): Promise<{ token: string; jwt: AuthClaims } | Response> {
  const log = debug('nebula.entrypoint.hostedUpgrade');
  const token = extractWebSocketToken(request);
  if (!token) {
    // Log the pathname, NOT request.url — a full URL can carry a query-string secret (security.md
    // § Never log secrets). The WS token rides the subprotocol, so the pathname is all we need.
    log.debug('rejected: missing access token', { path: new URL(request.url).pathname });
    return new Response('Unauthorized: missing access token', { status: 401 });
  }
  const jwt = await verifyAccessToken(token, env);
  if (!jwt) {
    log.debug('rejected: invalid JWT', { path: new URL(request.url).pathname });
    return new Response('Forbidden: invalid JWT', { status: 403 });
  }
  return { token, jwt };
}

/**
 * A Client's upgrade at `/gateway/{id}` on a scope's host, forwarded to the node the host spells,
 * which hosts it: on `tenant1.crm.acme.lumenize.dev`, `/gateway/alice.9f2c41aa` reaches the Star
 * `acme.crm.tenant1` as `/gateway/STAR/acme.crm.tenant1/alice.9f2c41aa`. The caller names the
 * scope its host spells and the binding each tier's node lives under.
 *
 * These refusals come before routing, so no upgrade reaches a node without a valid token for its
 * host whose `sub` begins the id: not an upgrade (426), not exactly one id segment (400), no token
 * or one that does not verify (401, 403), a token whose `aud` is not the host's scope (403), and an
 * id that does not begin with the token's `sub` (403). The node refuses a few more once it wakes,
 * such as a tag over 256 characters. The `aud` check is what keeps a token for one tenant's host
 * from holding a socket on another's. Every client-sent `x-lumenize-*` header is dropped, since
 * mesh stamps a node's name from them.
 */
export async function hostedUpgrade(request: Request, scope: string, tierBindings: TierBindings, env: Env): Promise<Response> {
  const log = debug('nebula.entrypoint.hostedUpgrade');
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  const segments = path.slice(`${GATEWAY_PREFIX}/`.length).split('/');
  if (segments.length !== 1 || segments[0] === '') {
    log.debug('refused: not one id segment', { path });
    return new Response('Bad Request: the upgrade path names no single client id', { status: 400 });
  }
  const [id] = segments;
  const verified = await verifiedUpgradeToken(request, env);
  if (verified instanceof Response) return verified;
  const { token, jwt } = verified;
  if (jwt.aud !== scope) {
    log.debug('refused: the token is for another host', { path, aud: jwt.aud, scope });
    return new Response('Forbidden: the token is for another host', { status: 403 });
  }
  const dot = id.indexOf('.');
  if (dot === -1 || id.slice(0, dot) !== jwt.sub) {
    log.debug('refused: the id is not the token\'s', { path, sub: jwt.sub });
    return new Response('Forbidden: identity mismatch', { status: 403 });
  }
  const binding = tierBindings[parseId(scope).tier];
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith('x-lumenize-')) headers.set(name, value);
  });
  headers.set('Authorization', `Bearer ${token}`);
  const forwarded = new Request(new URL(`${GATEWAY_PREFIX}/${binding}/${scope}/${id}`, url), {
    method: request.method, headers,
  });
  return (await routeDORequest(forwarded, env, { prefix: 'gateway', bindings: Object.values(tierBindings) }))
    ?? new Response('Not Found', { status: 404 });
}
