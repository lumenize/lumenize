/**
 * DevStudio's platform-fixed `Session`/`Message` resource ontology + its
 * `getOntology()` provider (Child 1, nebula-devstudio-data-plane.md Phase 2;
 * `Turn`→`Message` rename + field enrichment in Child 3 Phase 0).
 *
 * This is the ontology for the Studio chat's own Resources — **platform code,
 * not user data**: a fixed version defined here in source (D8), compiled **on
 * DevStudio** via the same `compileOntologyVersion` Galaxy uses (so the ADR-006
 * relationship/embed-guard threads identically), and mounted lazily through the
 * Worker Loader exactly like the tool-args facet. It is NOT a Galaxy ontology
 * version and never routes through Galaxy.
 *
 * `Message.session` is authored as a reference to the `Session` ontology type — the
 * to-one relationship Child 2 subscribes on. The write shape rewrites it to a
 * by-id `string`; embedding an object there is a loud ADR-006 error.
 *
 * ⚠️ Sentinel-version contract (review n1): the version is stamped into every
 * snapshot's `meta.ontologyVersion`. Editing these types is a BREAKING change —
 * bump {@link SESSION_MESSAGE_ONTOLOGY_VERSION} (and {@link SESSION_MESSAGE_BUNDLE_ID}
 * so a warm Worker-Loader doesn't serve a stale validator) *and* wipe DevStudio's
 * resource snapshots (there is no Galaxy version-registry / migration chain for it).
 */

import { compileOntologyVersion } from './galaxy';
import { ROOT_NODE_ID } from './dag-ops';
import { getParserValidatorFacet, extractTypeMetadata } from '@lumenize/ts-runtime-parser-validator';
import type { ParserValidator, TypeMetadata } from '@lumenize/ts-runtime-parser-validator';

/**
 * The fixed, well-known Session id for pre-alpha's single chat session (D-session).
 * Client and server agree on it as a **constant** — a fresh or late-joining client
 * subscribes `Message where session == DEFAULT_SESSION_ID` with NO discovery lookup.
 * Multi-session (many ids + a session-list/discovery surface) is deferred with the
 * management UI (D4). A fixed v4-shaped UUID so it round-trips the same id validation
 * as any client-supplied resource id.
 */
export const DEFAULT_SESSION_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The single DAG node every Message of a session lives under (D5, pre-alpha).
 * `ROOT_NODE_ID` for now — the session's permission scope; multi-node-per-session
 * is a non-goal. `targetsForQuery(sessionQuery, SESSION_NODE_ID)`'s single-node
 * recheck (Stage-2 M1) is provably correct under this pin.
 */
export const SESSION_NODE_ID = ROOT_NODE_ID;

/** The fixed, code-defined ontology version for the Session/Message data plane.
 *  Changes only on deploy (which reboots the DO → `onStart` re-derives it). */
export const SESSION_MESSAGE_ONTOLOGY_VERSION = 'session-message-v1';

/**
 * Worker-Loader bundle id for the compiled Session/Message validator. A fixed global
 * constant — the facet carries no tenant data, so it is safely shared across all
 * DevStudios. **Deliberately disjoint** from every other bundle-id namespace
 * (review M2 — a Worker-Loader collision silently serves the wrong validator =
 * validation bypass): the `nebula:` colon prefix cannot match the tool-args id
 * (`nebula-devstudio-tool-args-v1`) nor Star's `{universe.galaxy}/{version}` form
 * (whose pre-`/` segment always contains a `.`; this one's does not). The `/v2`
 * segment bumped with the Child-3 field enrichment so a warm loader re-compiles.
 */
export const SESSION_MESSAGE_BUNDLE_ID = 'nebula:devstudio-resource-ontology/v2';

/**
 * The Session/Message ontology, in source (ADR-001 — TS types ARE the schema).
 * `Message.session: Session` is the to-one relationship (write shape: a by-id
 * `string`). `status` ∈ {`thinking`,`streaming`,`complete`,`error`} (kept as
 * `string` to match `role`/`content` — the enum lives in the app, not a second
 * schema language). `thought` = the model-agnostic reasoning/progress surface;
 * `author` = display identity (email for humans — D-attribution, display-only,
 * never an authz key). Both optional (a user message has neither pre-set).
 */
export const SESSION_MESSAGE_TYPES = [
  'interface Session { title: string }',
  'interface Message { session: Session; role: string; content: string; status?: string; thought?: string; author?: string }',
].join('\n');

/**
 * Build the `getOntology()` provider the {@link ResourceDataPlane} consumes on
 * DevStudio: compiles the fixed Session/Message ontology on this DO (via
 * `compileOntologyVersion`) and mounts the validator through the Worker Loader.
 * The compile thunk only runs on a cold Worker-Loader build (cached by bundleId);
 * the version is server-sourced, never client-supplied.
 */
export function createResourceOntologyProvider(
  ctx: DurableObjectState,
  loader: WorkerLoader,
): () => { version: string; facet: ParserValidator; relationships: TypeMetadata['relationships'] } {
  // The relationship metadata is pure-parse-cheap and the types are a fixed
  // constant, so extract it ONCE here (factory body) and close over it — the
  // returned closure runs per resource op, but this never re-parses. Surfaced on
  // the seam for `subscribeQuery` field validation (D11); `Message.session` is the
  // to-one relationship Child 2 subscribes on.
  const relationships = extractTypeMetadata(SESSION_MESSAGE_TYPES).relationships;
  return () => {
    const facet = getParserValidatorFacet(
      ctx,
      loader,
      SESSION_MESSAGE_BUNDLE_ID,
      () => compileOntologyVersion({
        version: SESSION_MESSAGE_ONTOLOGY_VERSION,
        types: SESSION_MESSAGE_TYPES,
      }).validatorBundle,
    );
    return { version: SESSION_MESSAGE_ONTOLOGY_VERSION, facet, relationships };
  };
}
