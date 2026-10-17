/**
 * The page track into a Durable Object's `fetch` — the one forward a page request takes.
 *
 * A node's `fetch` hears from four kinds of caller: pages, a Client's upgrade, our own code, and
 * the node's own container. Each keeps a track of its own, so a page can reach only what a page may: its path is
 * rewritten under `/_public/`, which no other caller produces, and every `x-lumenize-*` header it
 * sent is stripped before this module sets its own. `https://dev.crm.acme.lumenize.dev/assets/app.js`
 * arrives as `/_public/assets/app.js`, named for the Galaxy the page step chose, carrying the scope
 * its host spelled. Our own code reaches a node through `rawRpcStub` instead, and the Galaxy's
 * container through `/api`, which this rewrite can never produce.
 *
 * Which binding and instance a host's request reaches is the page step's choice alone, so a later
 * helper peer at the same host is one more row there rather than another forward.
 */

/** The prefix every page request carries inside a node's `fetch`. */
export const PUBLIC_PREFIX = '/_public';

/** The scope the page's host spelled, set here and never taken from the request. */
export const PUBLIC_SCOPE_HEADER = 'x-lumenize-public-scope';

/** A Durable Object binding a page step forwards into. */
type PageBinding = { getByName(name: string): { fetch(request: Request): Promise<Response> } };

/**
 * The request a node's `fetch` receives for a page `request` on `scope`'s host, or the refusal.
 *
 * Pure, so its four properties are asserted without a node: anything but `GET` and `HEAD` is a 405
 * with `Allow: GET, HEAD`; an `Upgrade` is refused, since a page never reaches a node as a socket;
 * every `x-lumenize-*` header the client sent is dropped; and the path moves under
 * {@link PUBLIC_PREFIX}.
 */
export function publicRequest(
  request: Request, target: { binding: string; instanceName: string; scope: string },
): Request | Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (request.headers.get('Upgrade') !== null) {
    return new Response('A page request is never upgraded', { status: 426 });
  }
  const url = new URL(request.url);
  url.pathname = `${PUBLIC_PREFIX}${url.pathname}`;
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith('x-lumenize-')) headers.set(name, value);
  });
  headers.set('x-lumenize-do-binding-name', target.binding);
  headers.set('x-lumenize-do-instance-name-or-id', target.instanceName);
  headers.set(PUBLIC_SCOPE_HEADER, target.scope);
  return new Request(url, { method: request.method, headers });
}

/** {@link publicRequest}, forwarded to the instance the page step chose. */
export async function forwardPage(
  request: Request, binding: PageBinding, target: { binding: string; instanceName: string; scope: string },
): Promise<Response> {
  const forwarded = publicRequest(request, target);
  if (forwarded instanceof Response) return forwarded;
  return binding.getByName(target.instanceName).fetch(forwarded);
}
