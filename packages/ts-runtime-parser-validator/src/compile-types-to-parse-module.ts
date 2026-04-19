/**
 * Phase 1 stub — real implementation lands in Phase 5.
 *
 * Accepts a string of TypeScript interface definitions, returns a JS module
 * source string. The generated module exports a `ParserValidator` class
 * extending `DurableObject` (required by the DO facet loader, per
 * https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
 * — the facet callback calls `worker.getDurableObjectClass('ParserValidator')`).
 *
 * The class exposes `parse(value, typeName): { valid: true, data } | { valid: false, errors }`
 * as an RPC method. In the real implementation the class body bakes in:
 *   - typia-generated validators per resource type
 *   - typeMetadata (including @default values)
 *   - inlined runtime helpers (format validators, type guards, TypeGuardError)
 *
 * Phase 1 emits a hand-written module with no typia calls yet — enough to
 * prove facet load + RPC round-trip works end-to-end. Phase 5 replaces the
 * hand-written body with real typia output.
 */
export function compileTypesToParseModule(_typeDefinitions: string): string {
  return `
import { DurableObject } from "cloudflare:workers";

export class ParserValidator extends DurableObject {
  parse(value, typeName) {
    // Stub — Phase 5 replaces this with typia-generated dispatch + defaults fill.
    if (value && typeof value === 'object' && typeof value.title === 'string') {
      return { valid: true, data: value };
    }
    return {
      valid: false,
      errors: [{ path: '$', expected: typeName, value }],
    };
  }
}

export default { async fetch() { return new Response('ok'); } };
`;
}
