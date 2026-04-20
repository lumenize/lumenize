import { DurableObject } from 'cloudflare:workers';
import { compileTypesToParseModule } from '../src/compile-types-to-parse-module';

/**
 * Primary DO (supervisor). Compiles a validator module from posted type
 * definitions, loads it as a DO facet, then delegates `parse()` to the facet.
 *
 * In production (Nebula's Star DO), this is the topology: the Star owns the
 * facet, forwards parse calls into it via same-isolate RPC. The test mirrors
 * that topology so Phase 1 validates the real wiring, not a simplified shape.
 */
export class PrimaryDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      typeDefinitions: string;
      value: unknown;
      typeName: string;
      bundleId?: string;
    };
    const bundleId = body.bundleId ?? 'default';
    const moduleSource = compileTypesToParseModule(body.typeDefinitions);
    // `ctx.facets` and `worker.getDurableObjectClass` are beta APIs not yet in
    // @cloudflare/workers-types. Cast through unknown until the types land.
    const ctx = this.ctx as unknown as {
      facets: {
        get: (
          name: string,
          factory: () => Promise<{ class: unknown }>,
        ) => { parse: (value: unknown, typeName: string) => Promise<unknown> };
      };
    };
    const facet = ctx.facets.get(bundleId, async () => {
      const worker = this.env.LOADER.get(bundleId, async () => ({
        compatibilityDate: '2026-04-01',
        mainModule: 'parser.js',
        modules: { 'parser.js': moduleSource },
        globalOutbound: null,
      }));
      const w = worker as unknown as {
        getDurableObjectClass: (name: string) => unknown;
      };
      return { class: w.getDurableObjectClass('ParserValidator') };
    });
    const result = await facet.parse(body.value, body.typeName);
    return Response.json({ result, moduleSize: moduleSource.length });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/parse') {
      const stub = env.PRIMARY_DO.get(env.PRIMARY_DO.idFromName('primary'));
      return stub.fetch(request);
    }
    return new Response('ok');
  },
};
