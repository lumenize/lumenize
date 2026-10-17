import { DurableObject, WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
import { runProbe, probeStub, unavailableStub, type StubProbe } from './probe';

/**
 * An object-capability SESSION object. Returned from a DO/WorkerEntrypoint method, the caller holds a
 * stub to THIS instance across calls — a live server-side session. H1 predicts this is the ONE stub
 * kind that carries `Symbol.dispose` (so the caller can release the session).
 */
export class ProbeCap extends RpcTarget {
  #counter = 0;
  ping(): string {
    return 'cap-pong';
  }
  /** Per-session counter — proves a fresh stub gets a fresh session. */
  increment(): number {
    this.#counter += 1;
    return this.#counter;
  }
}

/** A minimal facet class (statically exported so ctx.exports can reference it) — the H3 (facet) row. */
export class ProbeFacet extends DurableObject {
  ping(): string {
    return 'facet-pong';
  }
}

export class ProbeDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS Kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
  }

  setValue(v: string): void {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO Kv (k, v) VALUES ('value', ?)`, v);
  }
  getValue(): string | null {
    const rows = [...this.ctx.storage.sql.exec(`SELECT v FROM Kv WHERE k = 'value'`)];
    return rows.length ? (rows[0].v as string) : null;
  }

  /** Return an RpcTarget session object — the stub-type-3 source (RpcTarget from a DO method). */
  getCap(): ProbeCap {
    return new ProbeCap();
  }

  /**
   * Probe a DO facet stub from inside the supervisor (ctx.facets exists only in DO context).
   * Best-effort: any failure (facets unsupported by this runtime / date / flag) is captured verbatim
   * as the row's note rather than breaking the whole matrix.
   */
  async probeFacet(): Promise<StubProbe> {
    try {
      const ctxAny = this.ctx as any;
      const facets = ctxAny.facets;
      if (!facets || typeof facets.get !== 'function') {
        return unavailableStub('do-facet-stub', 'ctx.facets is undefined (facets unsupported by this runtime)');
      }
      const facetClass = ctxAny.exports?.ProbeFacet;
      if (!facetClass) {
        return unavailableStub(
          'do-facet-stub',
          'ctx.exports.ProbeFacet is undefined (cannot obtain a facet DurableObjectClass)',
        );
      }
      const makeFacet = () => facets.get('probe-facet', () => ({ class: facetClass }));
      // Force init + one call so the stub is definitely live before we inspect it.
      await (makeFacet() as any).ping();
      return await probeStub('do-facet-stub', makeFacet);
    } catch (e) {
      return unavailableStub('do-facet-stub', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }
}

/**
 * A WorkerEntrypoint bound to this same worker (self-referencing service binding). The binding stub is
 * stub-type 5; the RpcTarget one of its methods returns is stub-type 4.
 */
export class ProbeEntrypoint extends WorkerEntrypoint<Env> {
  ping(): string {
    return 'we-pong';
  }
  getCap(): ProbeCap {
    return new ProbeCap();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/probe') {
      const matrix = await runProbe(env);
      matrix.runtime = url.searchParams.get('runtime') ?? 'unspecified';
      return Response.json(matrix);
    }
    return new Response('rpc-stub-disposability — GET /probe returns the disposability matrix', {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
