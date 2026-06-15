import { DurableObject } from 'cloudflare:workers';
import { generateParseModule } from '../src/generate-parse-module';
import { extractTypeMetadata } from '../src/extract-type-metadata';
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

  /**
   * Mirror Nebula's real ontology flow: take RAW types, extract metadata,
   * generate the validator from the *write shape* (relationship refs → id
   * strings) and pass the relationship map for loud-warning enrichment. This
   * is the path `Galaxy.compileOntologyVersion()` uses — tests exercise it to
   * cover the write-shape + relationship-error behavior end to end.
   */
  async parseWriteShape(
    rawTypeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId: string = 'ws-default',
  ): Promise<ParseResult> {
    const md = extractTypeMetadata(rawTypeDefinitions);
    const moduleSource = generateParseModule(md.writeShapeTypeDefinitions, md.relationships);
    const facet = getParserValidatorFacet(this.ctx, this.env.LOADER, bundleId, () => moduleSource);
    return await facet.parse(value, typeName);
  }
}

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response('ok');
  },
};
