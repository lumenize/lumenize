/**
 * The codegen tool-args validator's SOURCE + bundle id — a Node-safe LEAF (no imports
 * at all), shared by `codegen-loop.ts` (the tool surface) and
 * `scripts/gen-validator-seeds.ts` (which compiles them to the committed validator
 * literal under tsx) without either dragging the other's graph. The
 * `chat-constants.ts` / `chat-ontology.ts` split is the precedent.
 */

/** Tool-arg TS types — the ADR-001 source of truth for runtime validation. Compiled to
 *  a typia validator by `scripts/gen-validator-seeds.ts` and committed as
 *  `validator-seeds.ts`'s `TOOL_ARGS_VALIDATOR_MODULE` — never compiled at runtime.
 *  `BuildArgs.publish` is the model's publish OVERRIDE: the preview reloads by default
 *  only on a findings-free build, and the model may publish alongside findings it
 *  judges harmless (it cannot publish when the bundle failed — no `dist` exists). */
export const TOOL_ARGS_TYPES = `
interface WriteFileArgs { path: string; content: string; }
interface BuildArgs { publish?: boolean; }
interface MarkCompleteArgs {}
`;

/**
 * Stable Worker-Loader bundle id for the tool-args validator facet. The tool surface is
 * identical across tenants (not tenant data), so a shared id is correct — same
 * validator, shared cache (durable-objects.md Worker Loader cache).
 *
 * ⚠️ Any change to {@link TOOL_ARGS_TYPES} changes the emitted module, and this id MUST
 * bump with it: `getParserValidatorFacet` caches by id, so a changed module under a
 * reused id serves the STALE validator — and nothing catches a stale id the way the
 * generator's `--check` catches a stale literal.
 */
export const TOOL_ARGS_BUNDLE_ID = 'nebula-devstudio-tool-args-v3';
