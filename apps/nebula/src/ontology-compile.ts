/**
 * Ontology compilation — the pure half of the ontology pipeline, in a leaf module with NO mesh or
 * `cloudflare:workers` imports so it loads in plain Node too (the `/live` harness compiles an
 * ontology row to install on a running Star via `setOntology`; in-Worker callers are Galaxy,
 * Galaxy and the platform-fixed chat ontology). `galaxy.ts` re-exports everything here, so
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
 * Resources machinery (validation, snapshots, `actingToken` attribution, subscriptions, queries)
 * rather than a second store.
 *
 * ⚠️ Why not a second store (a sibling per-scope DO carrying platform out-of-band state)?
 * Considered and rejected for invite state (2026-08-20): the rows are keyed by Star DAG nodes and
 * flip beside `setPermission` writes, so co-location keeps that state machine inside one
 * single-threaded instance, and ADR-008 org-visibility + `requirePermission` already gate reads
 * and issuance correctly — a sibling DO would re-derive both and turn every flip into a cross-DO
 * message with a partial-failure window. A second store earns its keep only when the state is
 * decoupled from Star state, high-volume enough that per-row snapshot history is a cost rather
 * than a feature, or needs visibility other than org-visible; the out-of-band-events design
 * starts from that boundary.
 *
 * - `_InviteStatus` — one row per (email, node) a node invite has targeted (`Star.invite`), the
 *   live submission state the members panel query-subscribes (`pending` → `sent` /
 *   `submission-failed`). Org-visible like everything else at its node (ADR-008); rows get random
 *   opaque ids (ADR-010) with (email, node) as the uniqueness/query dimension, converged by the
 *   writer, never keyed on. `state`/`tier` stay `string` in the schema — the enum lives in the
 *   writing code, not a second schema language (the `Message.status` precedent).
 * - `_OrgNode` — a declaration-only relationship TARGET: the query machinery subscribes on to-one
 *   RELATIONSHIP fields (a field typed as another ontology type, stored as an id string), and
 *   `_InviteStatus.node` holds a DAG **node** id, which is not itself a Resource. Declaring
 *   `_OrgNode` makes that reference expressible in the one schema language (ADR-001) — nothing
 *   instantiates it.
 *
 * ⚠️ Type names beginning with `_` are RESERVED for the platform (the GraphQL-`__` / `sqlite_`
 * convention), and the guard below is EXPLICIT because TypeScript would not refuse a collision
 * for us: duplicate interfaces MERGE (declaration merging — an error only on member conflicts,
 * and even those don't block emit under the validator compiler's settings), so without the check
 * an app redeclaring a platform type would silently widen it. Reserving the PREFIX rather than
 * the current names means a future platform type can never collide with a conforming app and the
 * guard needs no edit when one is added — but every entry here MUST start with `_`, or it falls
 * outside the protected namespace (checked at module load below).
 *
 * ⚠️ Appending a platform type does not invalidate existing snapshots, but a WARM Worker-Loader
 * still serves the validator compiled without it (the bundle id derives from the app version,
 * which does not change) — a fresh boot or the pre-alpha wipe picks it up.
 */
export const PLATFORM_RESOURCE_TYPES: readonly string[] = [
  'interface _OrgNode { platformReserved?: string }',
  'interface _InviteStatus { node: _OrgNode; email: string; tier: string; state: string; error?: string }',
];

// Every platform type must live in the reserved `_` namespace — the prefix guard in
// `compileOntologyVersion` protects nothing outside it, so an entry without the prefix would
// silently reopen the app-collision hazard the guard exists to close.
for (const decl of PLATFORM_RESOURCE_TYPES) {
  const name = /^interface\s+([A-Za-z0-9_]+)/.exec(decl)?.[1];
  if (!name) throw new Error(`PLATFORM_RESOURCE_TYPES entry is not an interface declaration: ${decl}`);
  if (!name.startsWith('_')) {
    throw new Error(`PLATFORM_RESOURCE_TYPES entry is outside the reserved "_" namespace: ${decl}`);
  }
}

/**
 * Compile a versionConfig into a stored row. Throws on invalid TypeScript or
 * typia compile errors, and on an app type text that declares any `_`-prefixed
 * type name — the reserved platform namespace (see
 * {@link PLATFORM_RESOURCE_TYPES} — TS would silently MERGE a duplicate
 * otherwise); the caller surfaces the message to the admin.
 * {@link PLATFORM_RESOURCE_TYPES} are unioned in, so every version carries them.
 */
export function compileOntologyVersion(
  versionConfig: OntologyVersionConfig,
): OntologyVersionRow {
  // `interface X` / `type X =` / `class X` / `enum X` all collide in the type namespace.
  const underscored = /\b(?:interface|type|class|enum)\s+(_[A-Za-z0-9_]*)/.exec(versionConfig.types);
  if (underscored) {
    throw new Error(
      `Ontology type name "${underscored[1]}" starts with "_", which is reserved for platform ` +
      'types (PLATFORM_RESOURCE_TYPES) — rename the app type; TypeScript would otherwise merge ' +
      'a colliding declaration silently.',
    );
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
