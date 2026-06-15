/**
 * Duck-types a value as a Cloudflare `DurableObjectNamespace`.
 *
 * A DO namespace exposes `idFromName`/`getByName` (plus `idFromString`/`get`).
 * The catch: a Worker/service binding (a `Fetcher` / WorkerEntrypoint RPC stub) is a
 * Proxy that returns a function for *any* property access, so a method-presence check
 * alone reports `true` for it too. A real DO namespace is not a `Fetcher` and has no
 * `fetch`, whereas the service-binding stub does — so the **absence of `fetch`** is
 * what actually distinguishes them.
 *
 * Used to route mesh calls to the right transport and to guard {@link getDOStub}.
 *
 * @example
 * isDONamespace(env.MY_DO);      // true  — Durable Object namespace
 * isDONamespace(env.MY_WORKER);  // false — Worker/service binding (has fetch)
 */
export function isDONamespace(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { idFromName?: unknown }).idFromName === 'function' &&
    typeof (value as { getByName?: unknown }).getByName === 'function' &&
    // A Fetcher / RPC-stub Proxy fakes idFromName/getByName above; a real DO
    // namespace has no `fetch`, the service-binding stub does.
    typeof (value as { fetch?: unknown }).fetch !== 'function'
  );
}
