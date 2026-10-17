/**
 * Waiting for a new app's host to answer.
 *
 * Creating an app orders its certificate pack, and until the pack is active `crm.acme.lumenize.dev`
 * fails its TLS handshake. `.dev` is HSTS-preloaded, so a browser sent there shows an error with no
 * way past it, and a pack takes two and a half to four minutes. So the page that sends a person into
 * a new app polls the destination itself and leaves only once it answers: a `no-cors` request
 * rejects while the handshake fails and resolves once it succeeds. A page on the platform host holds
 * no token, so it could not ask the Galaxy about its pack, and the poll measures what the person
 * needs directly. The local stack's `http` hosts answer the first probe, so locally it ends at once.
 */

/** How long between probes while the host does not answer. */
export const PROBE_INTERVAL_MS = 2000;
/** Each probe's own bound, so a connection that hangs rather than failing still counts as a miss. */
const PROBE_TIMEOUT_MS = 5000;

/** One probe of `origin`: resolves when its host answers, rejects while it does not. */
export function probeHost(origin: string): Promise<unknown> {
  return fetch(`${origin}/`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

/**
 * Resolves once `url`'s origin answers, probing every `intervalMs`. `onWaiting` fires once, when the
 * first probe misses, so a page shows its wait only when there is one. Resolves without a further
 * probe once `signal` aborts, for a page that has gone elsewhere. A relative `url`, such as the
 * `/auth/signup` a link's page may be sent to, is on this page's own host, which is answering, so it
 * resolves at once.
 */
export async function waitUntilHostAnswers(
  url: string,
  opts: { onWaiting?: () => void; probe?: (origin: string) => Promise<unknown>; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  if (!URL.canParse(url)) return;
  const origin = new URL(url).origin;
  const probe = opts.probe ?? probeHost;
  let missed = false;
  while (!opts.signal?.aborted) {
    try {
      await probe(origin);
      return;
    } catch {
      if (!missed) { missed = true; opts.onWaiting?.(); }
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? PROBE_INTERVAL_MS));
  }
}
