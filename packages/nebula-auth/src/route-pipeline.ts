/**
 * The runner a route table's step lists execute on.
 *
 * Deliberately knows nothing about Nebula: no scope grammar, no claims, no bindings. A consumer
 * supplies a table of `{ path, method?, steps }` and the runner matches, then folds the list.
 * See `tasks/nebula-route-pipeline.md` for the contract's reasoning.
 */

/**
 * What a step may hand back.
 *
 * `Response` refuses and short-circuits · `Request` replaces the one later steps receive ·
 * `undefined` continues with the request unchanged. A step that throws is NOT caught here — the
 * rejection propagates to whatever embeds the runner, and that embedder answers.
 *
 * ⚠️ Building a replacement MOVES the body onto it — nothing is copied or re-serialized, but the
 * original stops being readable. Harmless when you return the replacement, which is the only reason
 * to build one. **The hazard is building one and NOT returning it**, since the runner goes on
 * handing later steps the original.
 */
export type StepResult = Response | Request | void;

/**
 * A step declares the slice of state it REQUIRES and the slice it ADDS, so a handler reads what it
 * needs non-optionally because it said it needs it. Nothing checks the ORDER of a list — the array
 * is read left to right and that reading is the audit.
 */
export type Step<Needs extends object = {}, Adds extends object = {}> = (
  request: Request,
  routeState: Needs & Partial<Adds>,
) => Promise<StepResult> | StepResult;

/**
 * The value threaded through a route's step list — `routeState`. Every route's starts here and steps
 * add to it. Captures are flat: `params.id`, never `params.pathname.groups.id`.
 */
export type RouteState = { params: Record<string, string> };

/**
 * An entry in a route table.
 *
 * An absent `method` takes ANY verb. That is right for a consumer indifferent to verbs and wrong
 * for one whose routes are single-verb, which is a policy for the consumer to hold, not the runner.
 *
 * `steps` is typed loosely on purpose: the entries of one list have different `Needs`/`Adds`, and
 * relating them would need the tuple fold this design declines.
 */
export type RouteEntry = {
  path: string;
  method?: string;
  steps: readonly Step<any, any>[];
};

/** A compiled table. Call it per request; it holds no per-request state. */
export type RouteRunner = (request: Request) => Promise<Response | undefined>;

/**
 * Compile a table once, then run requests through it.
 *
 * Returns `undefined` when no entry's path matched, so the runner composes in a chain of routers —
 * *not my path, try the next one*. It answers `405` itself when a path matched but no entry took
 * the verb, because only the table can tell a wrong verb from an absent route; and `500` when a
 * matched entry's list ran out without answering, which is a registered-but-broken route and must
 * not read as an unregistered one.
 *
 * Responses are returned UNDECORATED — CORS and friends belong to the embedder.
 */
export function createRouter(routes: readonly RouteEntry[]): RouteRunner {
  // ⚠️ The table's method is uppercased so its spelling does not matter. The platform normalises only
  // the standard verbs — measured: `{method:'get'}` arrives as `GET`, `{method:'patch'}` stays
  // `patch` — so without this a `method: 'get'` entry silently never matches and the request 405s.
  // The REQUEST's method is compared as-is: HTTP methods are case-sensitive (RFC 9110 §9.1), and
  // uppercasing it would invent lenient matching for non-standard verbs.
  const compiled = routes.map((entry) => ({
    entry,
    method: entry.method?.toUpperCase(),
    pattern: new URLPattern({ pathname: entry.path }),
  }));

  return async (request: Request): Promise<Response | undefined> => {
    let pathMatched = false;

    const allowed = new Set<string>();

    for (const { entry, method, pattern } of compiled) {
      const match = pattern.exec(request.url);
      if (!match) continue;
      pathMatched = true;
      // A path match with a different verb is SKIPPED, not refused — two entries may share a path.
      if (method !== undefined && method !== request.method) {
        allowed.add(method);
        continue;
      }
      return await runSteps(entry, request, match);
    }

    // RFC 9110 §15.5.6 requires `Allow` on a 405, and only the table knows what it would accept.
    return pathMatched
      ? new Response('Method Not Allowed', {
          status: 405,
          headers: { allow: [...allowed].sort().join(', ') },
        })
      : undefined;
  };
}

async function runSteps(
  entry: RouteEntry,
  request: Request,
  match: URLPatternResult,
): Promise<Response> {
  // Built per call. Hoisting this would leak one request's state into the next in a reused isolate.
  const routeState: RouteState = { params: { ...match.pathname.groups } };
  let current = request;

  for (const step of entry.steps) {
    const result = await step(current, routeState);
    if (result instanceof Response) return result;
    if (result instanceof Request) current = result;
  }

  return new Response('Route produced no response', { status: 500 });
}
