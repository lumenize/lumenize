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
 *  `BuildArgs.preview` is the model's call on the `.dev` preview: a build lands by default
 *  only when it has no type findings, `true` lands one whose findings the model judges
 *  harmless, `false` holds a clean one back, and a build not previewed is served nowhere
 *  (never landing when the bundle failed — no `dist` exists). `EditFileArgs`
 *  names one span: `anchor` must occur exactly once. `postId` on a loop tool names the held
 *  post whose poster's claims the call runs under, the post its turn took up when absent.
 *  `TakeUpArgs` is a decision's pick, and `MarkCompleteArgs.answers` the posts the turn's final
 *  message answers. `InviteArgs` names no post, deliberately: an invite changes who can do what,
 *  so it runs under the post its turn took up and the model cannot choose another. ⚠️ The facet is `createValidate`,
 *  which IGNORES excess keys — `Galaxy.#validateToolArgs` refuses them by name against
 *  the tool's declared properties, so a stale `publish` key cannot be silently dropped. */
export const TOOL_ARGS_TYPES = `
interface WriteFileArgs { path: string; content: string; postId?: string; }
interface ReadFileArgs { path: string; postId?: string; }
interface EditFileArgs { path: string; anchor: string; replacement: string; postId?: string; }
interface BuildArgs { preview?: boolean; postId?: string; }
interface MarkCompleteArgs { answers?: string[]; }
interface TakeUpArgs { postId: string; }
interface InviteArgs { email: string; scopeAdmin?: boolean; }
`;

/**
 * Stable Worker-Loader bundle id for the tool-args validator facet. The tool surface is
 * identical across tenants (not tenant data), so a shared id is correct — same
 * validator, shared cache (durable-objects.md Worker Loader cache).
 *
 * ⚠️ Any change to {@link TOOL_ARGS_TYPES} changes the emitted module, and this id MUST
 * bump with it: `getParserValidatorFacet` caches by id, so a changed module under a
 * reused id serves the STALE validator — and nothing catches a stale id the way the
 * generator's `--check` catches a stale literal. v4: `read_file` + `edit_file` joined,
 * `BuildArgs.publish` became `preview` (2026-09-05). v5: each loop tool's optional `postId`,
 * `take_up`, and `mark_complete`'s `answers` (2026-11-11). v6: `invite` joined (2026-11-11).
 */
export const TOOL_ARGS_BUNDLE_ID = 'nebula-devstudio-tool-args-v6';
