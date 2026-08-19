/**
 * Ontology compilation — the pure half of the ontology pipeline, in a leaf module with NO mesh or
 * `cloudflare:workers` imports so it loads in plain Node too (the `/live` harness compiles an
 * ontology row to install on a running Star via `setOntology`; in-Worker callers are Galaxy,
 * DevStudio and the platform-fixed DevStudio ontology). `galaxy.ts` re-exports everything here, so
 * existing import sites are untouched.
 *
 * ⚠️ NOT browser-safe — `generateParseModule` pulls the bundled tsc/typia deps (multi-MB, Node/
 * workerd only). Keep it out of `client-index.ts`.
 */
import { extractTypeMetadata, generateParseModule } from '@lumenize/ts-runtime-parser-validator';
import type { TypeMetadata } from '@lumenize/ts-runtime-parser-validator';

export interface OntologyVersionConfig {
  version: string;
  types: string;
}

/**
 * Compiled, stored-per-version row. Immutable after write.
 *
 * `relationships` rides along for 5.5's lazy-migration path — no Phase 1–6
 * code reads it, but co-locating it with `validatorBundle` saves the future
 * migrator a re-extract on every cold migration.
 */
export interface OntologyVersionRow {
  version: string;
  types: string;
  validatorBundle: string;
  relationships: TypeMetadata['relationships'];
}

/**
 * Platform-fixed Resource types, unioned into EVERY compiled ontology version — entities the
 * PLATFORM writes on a host's data plane regardless of what the app defines, riding the ordinary
 * Resources machinery (validation, snapshots, `changedBy` attribution, subscriptions, queries)
 * rather than a second store.
 *
 * - `InviteStatus` — one row per (email, node) a node invite has targeted (`Star.invite`), the
 *   live submission state the members panel query-subscribes (`pending` → `sent` /
 *   `submission-failed`). Org-visible like everything else at its node (ADR-008); rows get random
 *   opaque ids (ADR-010) with (email, node) as the uniqueness/query dimension, converged by the
 *   writer, never keyed on. `state`/`tier` stay `string` in the schema — the enum lives in the
 *   writing code, not a second schema language (the `Message.status` precedent).
 * - `OrgNode` — a declaration-only relationship TARGET: the query machinery subscribes on to-one
 *   RELATIONSHIP fields (a field typed as another ontology type, stored as an id string), and
 *   `InviteStatus.node` holds a DAG **node** id, which is not itself a Resource. Declaring
 *   `OrgNode` makes that reference expressible in the one schema language (ADR-001) — nothing
 *   instantiates it.
 *
 * ⚠️ These names are RESERVED, and the guard below is EXPLICIT because TypeScript would not
 * refuse for us: duplicate interfaces MERGE (declaration merging — an error only on member
 * conflicts, and even those don't block emit under the validator compiler's settings), so without
 * the check an app declaring `InviteStatus` would silently widen the platform type — the exact
 * silent override a reserved name must never become.
 *
 * ⚠️ Appending a platform type does not invalidate existing snapshots, but a WARM Worker-Loader
 * still serves the validator compiled without it (the bundle id derives from the app version,
 * which does not change) — a fresh boot or the pre-alpha wipe picks it up.
 */
export const PLATFORM_RESOURCE_TYPES: readonly string[] = [
  'interface OrgNode { platformReserved?: string }',
  'interface InviteStatus { node: OrgNode; email: string; tier: string; state: string; error?: string }',
];

/** The reserved type names, derived from the declarations so the two can never drift. */
const RESERVED_TYPE_NAMES: readonly string[] = PLATFORM_RESOURCE_TYPES.map((decl) => {
  const name = /^interface\s+([A-Za-z0-9_]+)/.exec(decl)?.[1];
  if (!name) throw new Error(`PLATFORM_RESOURCE_TYPES entry is not an interface declaration: ${decl}`);
  return name;
});

/**
 * Compile a versionConfig into a stored row. Throws on invalid TypeScript or
 * typia compile errors, and on an app type text that declares a reserved
 * platform name (see {@link PLATFORM_RESOURCE_TYPES} — TS would silently MERGE
 * the duplicate otherwise); the caller surfaces the message to the admin.
 * {@link PLATFORM_RESOURCE_TYPES} are unioned in, so every version carries them.
 */
export function compileOntologyVersion(
  versionConfig: OntologyVersionConfig,
): OntologyVersionRow {
  for (const reserved of RESERVED_TYPE_NAMES) {
    // `interface X` / `type X =` / `class X` all collide in the type namespace.
    if (new RegExp(`\\b(?:interface|type|class|enum)\\s+${reserved}\\b`).test(versionConfig.types)) {
      throw new Error(
        `Ontology type name "${reserved}" is reserved by the platform (PLATFORM_RESOURCE_TYPES) — ` +
        'rename the app type; TypeScript would otherwise merge the declarations silently.',
      );
    }
  }
  const md = extractTypeMetadata([...PLATFORM_RESOURCE_TYPES, versionConfig.types].join('\n'));
  // Pass the original relationship map so the generated validator can emit a
  // loud, actionable error when a caller embeds an object in a relationship
  // field instead of referencing the related resource by id (the write shape
  // types relationships as `string`, which otherwise yields an opaque
  // "expected (string | undefined)").
  const validatorBundle = generateParseModule(md.writeShapeTypeDefinitions, md.relationships);
  return {
    version: versionConfig.version,
    types: versionConfig.types,
    validatorBundle,
    relationships: md.relationships,
  };
}
