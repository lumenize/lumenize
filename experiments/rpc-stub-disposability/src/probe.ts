/**
 * Shared probe logic — the SAME code path runs in every environment (pool-workers via SELF.fetch,
 * local `wrangler dev`, and deployed). The JSON matrix it returns is the experiment's raw evidence.
 *
 * Primary signal is `typeof stub[Symbol.dispose]` — pure runtime, independent of how the `using`
 * down-level transform behaves. The `using` / `await using` throw-tests are the practical
 * consequence and a secondary signal (their exact message can be shaped by the esbuild/tsc transform).
 */

export interface StubProbe {
  /** Which of the 6 stub kinds this row is. */
  stubType: string;
  /** typeof stub[Symbol.dispose] — GROUND TRUTH. 'function' ⇒ disposable, 'undefined' ⇒ not. */
  symbolDispose: string;
  /** typeof stub[Symbol.asyncDispose]. */
  symbolAsyncDispose: string;
  /** stub?.constructor?.name — structural tell (DurableObject / Fetcher / RpcStub / …). */
  ctor: string | null;
  /** Did `using x = stub` throw? (practical consequence; message may reflect the down-level transform). */
  usingThrew: boolean;
  usingMessage: string | null;
  /** Did `await using x = stub` throw? */
  awaitUsingThrew: boolean;
  awaitUsingMessage: string | null;
  /** Populated only for rows that couldn't be probed (e.g. facets unsupported by the runtime). */
  note?: string;
}

export interface ProbeMatrix {
  /** Stamped by the caller from the `?runtime=` query: 'pool-workers' | 'wrangler-dev' | 'deployed'. */
  runtime: string;
  /** Runtime fingerprint (workerd exposes its build string via navigator.userAgent). */
  userAgent: string;
  stubs: StubProbe[];
  behavior: {
    /** DO: after dropping the stub with NO dispose, does a FRESH stub still see the state? (pointer tell) */
    doStatePersistsAcrossFreshStub: boolean | null;
    /** RpcTarget: is the counter session per-stub (fresh cap ⇒ counter resets to 1)? (session tell) */
    rpcSessionIsPerStub: boolean | null;
    note?: string;
  };
}

/** Run `using x = stub` on a throwaway stub and report whether it threw. */
function tryUsing(stub: unknown): { threw: boolean; message: string | null } {
  try {
    {
      using _x = stub as Disposable;
      void _x;
    }
    return { threw: false, message: null };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Run `await using x = stub` on a throwaway stub and report whether it threw. */
async function tryAwaitUsing(stub: unknown): Promise<{ threw: boolean; message: string | null }> {
  try {
    {
      await using _x = stub as AsyncDisposable;
      void _x;
    }
    return { threw: false, message: null };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Probe one stub kind. `makeStub` is called up to 3× so each destructive `using` test disposes a
 * FRESH stub — never the inspected one, never each other's. This matters for the disposable
 * RpcTarget rows, where a real `using` actually releases the server-side session.
 */
export async function probeStub(
  stubType: string,
  makeStub: () => unknown | Promise<unknown>,
): Promise<StubProbe> {
  const inspect = (await makeStub()) as any;
  const symbolDispose = typeof inspect?.[Symbol.dispose];
  const symbolAsyncDispose = typeof inspect?.[Symbol.asyncDispose];
  let ctor: string | null = null;
  try {
    ctor = inspect?.constructor?.name ?? null;
  } catch {
    ctor = null;
  }

  const u = tryUsing(await makeStub());
  const au = await tryAwaitUsing(await makeStub());

  return {
    stubType,
    symbolDispose,
    symbolAsyncDispose,
    ctor,
    usingThrew: u.threw,
    usingMessage: u.message,
    awaitUsingThrew: au.threw,
    awaitUsingMessage: au.message,
  };
}

/** A row for a stub kind that can't be probed in this runtime (e.g. facets unsupported). */
export function unavailableStub(stubType: string, reason: string): StubProbe {
  return {
    stubType,
    symbolDispose: 'n/a',
    symbolAsyncDispose: 'n/a',
    ctor: null,
    usingThrew: false,
    usingMessage: null,
    awaitUsingThrew: false,
    awaitUsingMessage: null,
    note: `unavailable: ${reason}`,
  };
}

/** The pointer-vs-session behavioral tells (see ProbeMatrix.behavior). */
async function runBehaviorProbes(env: Env): Promise<ProbeMatrix['behavior']> {
  let doStatePersistsAcrossFreshStub: boolean | null = null;
  try {
    const a = env.PROBE.getByName('behavior-do');
    await a.setValue('persisted-value');
    // `a` goes out of scope here with NO dispose — because a DO stub is just a pointer, the DO's
    // stored state is untouched, and a fresh stub reads it back.
    const b = env.PROBE.getByName('behavior-do');
    doStatePersistsAcrossFreshStub = (await b.getValue()) === 'persisted-value';
  } catch {
    doStatePersistsAcrossFreshStub = null;
  }

  let rpcSessionIsPerStub: boolean | null = null;
  try {
    const src = env.PROBE.getByName('behavior-cap');
    const capA = (await src.getCap()) as any;
    const a1 = await capA.increment(); // 1 — session state lives on THIS stub
    const a2 = await capA.increment(); // 2
    const capB = (await src.getCap()) as any; // a fresh RpcTarget ⇒ a fresh session
    const b1 = await capB.increment(); // 1 again — independent counter
    rpcSessionIsPerStub = a1 === 1 && a2 === 2 && b1 === 1;
  } catch {
    rpcSessionIsPerStub = null;
  }

  return { doStatePersistsAcrossFreshStub, rpcSessionIsPerStub };
}

/** Build the full matrix. The same function drives every environment. */
export async function runProbe(env: Env): Promise<ProbeMatrix> {
  const stubs: StubProbe[] = [];

  // 1 — DO stub via get(idFromName)
  stubs.push(
    await probeStub('do-stub-get-idFromName', () => env.PROBE.get(env.PROBE.idFromName('probe-a'))),
  );
  // 2 — DO stub via getByName
  stubs.push(await probeStub('do-stub-getByName', () => env.PROBE.getByName('probe-b')));
  // 5 — WorkerEntrypoint binding stub itself
  stubs.push(await probeStub('worker-entrypoint-binding', () => env.SELF_SERVICE));
  // 4 — RpcTarget returned from a WorkerEntrypoint method
  stubs.push(
    await probeStub('rpc-target-from-worker-entrypoint', () => (env.SELF_SERVICE as any).getCap()),
  );
  // 3 — RpcTarget returned from a DO method
  const capDO = env.PROBE.getByName('probe-cap-source');
  stubs.push(await probeStub('rpc-target-from-do', () => (capDO as any).getCap()));
  // 6 — DO facet stub (best-effort; probed inside the supervisor DO where ctx.facets lives)
  try {
    stubs.push(await env.PROBE.getByName('facet-supervisor').probeFacet());
  } catch (e) {
    stubs.push(
      unavailableStub('do-facet-stub', e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
    );
  }

  const behavior = await runBehaviorProbes(env);

  return {
    runtime: 'unknown',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a',
    stubs,
    behavior,
  };
}
