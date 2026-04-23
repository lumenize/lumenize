import { DurableObject } from 'cloudflare:workers';
import { generateParseModule } from '../src/generate-parse-module';
import { getParserValidatorFacet, type ParserValidator } from '../src/facet-helper';

/**
 * Primary DO (supervisor). Compiles a validator module from posted type
 * definitions, loads it as a DO facet via `getParserValidatorFacet()`, then
 * delegates `parse()` to the facet.
 *
 * In production (Nebula's Star DO), this is the topology: the Star owns the
 * facet, forwards parse calls into it via same-isolate RPC. The test mirrors
 * that topology so Phase 1 validates the real wiring, not a simplified shape.
 *
 * Using `getParserValidatorFacet` here also dogfoods the helper — the full
 * existing test suite exercises it through the same execution paths that
 * cover `generateParseModule()` output.
 *
 * Two entry points for the test harness:
 *   - HTTP `/parse`: body is JSON (forces JSON serialisation of values —
 *     suitable for typeDefinitions + simple values).
 *   - RPC `rpcParse(typeDefinitions, typeName, value, bundleId)`: called
 *     as `stub.rpcParse(...)` from the test. Values cross via **Workers RPC**,
 *     which preserves Date, Map, Set, RegExp, TypedArrays, cyclic refs, etc.
 *     This is the production serialisation path (Star → facet) and the right
 *     harness for the JS-values parity tests.
 */
export class PrimaryDO extends DurableObject<Env> {
  #getFacetForBundle(
    typeDefinitions: string,
    bundleId: string,
  ): { facet: ParserValidator; moduleSize: number } {
    const moduleSource = generateParseModule(typeDefinitions);
    const facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => moduleSource,
    );
    return { facet, moduleSize: moduleSource.length };
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      typeDefinitions: string;
      value: unknown;
      typeName: string;
      bundleId?: string;
    };
    const bundleId = body.bundleId ?? 'default';
    const { facet, moduleSize } = this.#getFacetForBundle(body.typeDefinitions, bundleId);
    const result = await facet.parse(body.value, body.typeName);
    return Response.json({ result, moduleSize });
  }

  /**
   * RPC entry point — test code calls this via `stub.rpcParse(...)`.
   * Values cross via Workers RPC (structured-clone semantics), preserving
   * the rich types that JSON can't.
   */
  async rpcParse(
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId: string = 'rpc-default',
  ): Promise<unknown> {
    const { facet } = this.#getFacetForBundle(typeDefinitions, bundleId);
    return await facet.parse(value, typeName);
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
