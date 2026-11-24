/**
 * A subscribe's answer is its first push, not the call's own return: the subscribe goes out one
 * way, and the host's push settles it. {@link awaitFirstPush} is that wait, shared by a Client's
 * Profile channel and by any subscription plane a subclass composes.
 *
 * Client-safe: no Workers runtime import, so `@lumenize/mesh/client` re-exports it.
 */

/**
 * Default ceiling on a subscribe's wait for its first push. It matches the host node's own
 * `CLIENT_CALL_TIMEOUT_MS` deliberately: the leg it covers ends at a push to the Client, so a Client
 * that gave up sooner would abandon subscribes its host node is still willing to deliver.
 */
export const SUBSCRIBE_TIMEOUT_MS = 30000;

/** A subscribe waiting for its first push: the settlers the push handler calls. */
export interface PendingPush<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Wait for the first push to `key`, firing the subscribe with `fire()`. A second wait on a key
 * already pending joins the first instead of firing again, and both settle together. The push
 * handler settles the wait by taking `key` out of `pending` and calling its `resolve` or `reject`.
 *
 * ⚠️ **The wait is bounded, and the bound is all that stands between an undelivered push and a
 * permanent hang.** Only the push handler settles it, so anything that stops the handler running
 * (a refusal at the mesh entry rule, a dropped socket, a host that never answers) leaves nothing
 * able to. After `timeoutMs` the timeout goes to `abandon`, which should be the same door a
 * host-reported error takes, so abandoning runs that path's cleanup rather than a second copy of it.
 */
export function awaitFirstPush<T>(
  pending: Map<string, PendingPush<T>>,
  key: string,
  fire: () => void,
  abandon: (reason: Error) => void,
  timeoutMs: number = SUBSCRIBE_TIMEOUT_MS,
): Promise<T> {
  // Join a wait already pending. Its settlers are captured as plain function values, not read back
  // through the entry, which would make the chained closure call itself.
  //
  // The timer belongs to the first wait's entry, and its settlers clear it; every joined settler
  // calls through them, so a joining wait neither re-arms the timer nor orphans it.
  const inFlight = pending.get(key);
  if (inFlight) {
    return new Promise<T>((resolve, reject) => {
      const prevResolve = inFlight.resolve;
      const prevReject = inFlight.reject;
      inFlight.resolve = (value) => { prevResolve(value); resolve(value); };
      inFlight.reject = (err) => { prevReject(err); reject(err); };
    });
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abandon(new Error(
        `Subscribe to '${key}' was never acknowledged within ${timeoutMs}ms — no push arrived. ` +
        `Either the host never delivered, or this client refused the inbound push; a refusal is ` +
        `logged here under 'lmz.mesh.LumenizeClient.#handleIncomingCall'.`
      ));
    }, timeoutMs);
    pending.set(key, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    fire();
  });
}
