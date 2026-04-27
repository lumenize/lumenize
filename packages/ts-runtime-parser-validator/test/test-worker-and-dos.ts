import { DurableObject } from 'cloudflare:workers';
import { generateParseModule } from '../src/generate-parse-module';
import { getParserValidatorFacet, type ParserValidator } from '../src/facet-helper';
import type { ParseRequest, ParseResult } from '../src/facet-helper';

/**
 * Primary DO (supervisor). Compiles a validator module from posted type
 * definitions, loads it as a DO facet via `getParserValidatorFacet()`, then
 * delegates `parse()` / `parseBatch()` to the facet.
 *
 * In production (Nebula's Star DO), this is the topology: the Star owns the
 * facet, forwards parse calls into it via same-isolate RPC. The test mirrors
 * that topology so the suite validates the real wiring, not a simplified shape.
 *
 * Using `getParserValidatorFacet` here also dogfoods the helper — the full
 * existing test suite exercises it through the same execution paths that
 * cover `generateParseModule()` output.
 *
 * Test code calls `stub.parse(...)` and `stub.parseBatch(...)` directly via
 * Workers RPC, which preserves Date, Map, Set, RegExp, TypedArrays, cyclic
 * refs, etc. — the production serialisation path (Star → facet).
 */
export class PrimaryDO extends DurableObject<Env> {
  #getFacetForBundle(typeDefinitions: string, bundleId: string): ParserValidator {
    const moduleSource = generateParseModule(typeDefinitions);
    return getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => moduleSource,
    );
  }

  async parse(
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId: string = 'rpc-default',
  ): Promise<ParseResult> {
    const facet = this.#getFacetForBundle(typeDefinitions, bundleId);
    return await facet.parse(value, typeName);
  }

  async parseBatch(
    typeDefinitions: string,
    items: Map<string, ParseRequest>,
    bundleId: string = 'rpc-default',
  ): Promise<Map<string, ParseResult>> {
    const facet = this.#getFacetForBundle(typeDefinitions, bundleId);
    return await facet.parseBatch(items);
  }
}

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response('ok');
  },
};
