import { DurableObject } from 'cloudflare:workers';

/**
 * The structured result shape returned by `ParserValidator.parse()`.
 *
 * Mirrors the interface baked into the emitted module by
 * `generateParseModule()`. Duplicated here (not imported from the emitted
 * module, which doesn't exist at caller-compile time) so callers can
 * annotate their own wrappers.
 */
export type ParseResult =
  | { valid: true;  data: unknown }
  | { valid: false; errors: ValidationError[] };

/**
 * One entry in `ParseResult.errors` when validation fails.
 */
export interface ValidationError {
  path: string;        // JSON-pointer-like path: '$input.address.city'
  expected: string;    // The expected type, e.g. 'string', '(number | undefined)'
  value: unknown;      // The offending value
  description?: string; // Optional typia-supplied note
}

/**
 * One entry in a `parseBatch()` input Map. Identity is the Map key, so no
 * `id` field — caller picks any string key (Nebula uses `resourceId`).
 */
export type ParseRequest = { value: unknown; typeName: string };

/**
 * Internal brand type — the shape of the `ParserValidator` class inside the
 * generated module. Used to type `getDurableObjectClass<T>` and `facets.get<T>`,
 * which require `Rpc.DurableObjectBranded`. Not exported: callers don't
 * instantiate this class directly, they call methods on the RPC stub.
 */
interface ParserValidatorClass extends DurableObject {
  parse(value: unknown, typeName: string): ParseResult;
  parseBatch(items: Map<string, ParseRequest>): Map<string, ParseResult>;
}

/**
 * The public RPC surface of the facet returned by `getParserValidatorFacet()`.
 * Methods are async because they cross the facet's same-isolate RPC boundary.
 * Users calling the helper interact with this type directly.
 */
export type ParserValidator = {
  parse(value: unknown, typeName: string): Promise<ParseResult>;
  parseBatch(items: Map<string, ParseRequest>): Promise<Map<string, ParseResult>>;
};

/**
 * Mount the `ParserValidator` class from a pre-generated module as a DO
 * facet, returning a typed stub whose `parse()` method you can call
 * directly.
 *
 * Both `ctx.facets.get()` and `loader.get()` are cache lookups — neither
 * setup callback runs on the hot path once a `bundleId` is active. The
 * innermost block (where `loadModuleSource` is invoked) only fires when the
 * Dynamic Worker for this `bundleId` isn't yet loaded project-wide. See the
 * Getting Started guide for the lifecycle.
 *
 * The `ctx` and `loader` parameter types come from the global types that
 * `wrangler types` generates — no imports needed on the caller side.
 *
 * @param ctx      - The DO's `ctx` (usually `this.ctx` from inside a DO class).
 * @param loader   - The Worker Loader binding (usually `this.env.LOADER`).
 * @param bundleId - Stable identifier for the generated module. Reuse to
 *   reuse the cached Worker and facet; change to swap in a new validator.
 * @param loadModuleSource - Callback returning the JS module source string
 *   produced by `generateParseModule()`. Sync or async — `ctx.storage.kv`
 *   is sync; KV-namespace bindings, R2, and cross-Worker RPC are async.
 *   Only invoked on a cold Worker build, so sync readers pay nothing extra
 *   on per-request calls.
 */
export function getParserValidatorFacet(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  bundleId: string,
  loadModuleSource: () => string | Promise<string>,
): ParserValidator {
  const stub = ctx.facets.get<ParserValidatorClass>(bundleId, async () => {
    const worker = loader.get(bundleId, async () => {
      const moduleSource = await loadModuleSource();
      return {
        compatibilityDate: '2026-04-01',
        mainModule: 'parser.js',
        modules: { 'parser.js': moduleSource },
        globalOutbound: null,
      };
    });
    return {
      class: worker.getDurableObjectClass<ParserValidatorClass>('ParserValidator'),
    };
  });
  return stub as unknown as ParserValidator;
}
