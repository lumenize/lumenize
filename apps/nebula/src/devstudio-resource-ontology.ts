/**
 * DevStudio's platform-fixed `Session`/`Turn` resource ontology + its
 * `getOntology()` provider (Child 1, nebula-devstudio-data-plane.md Phase 2).
 *
 * This is the ontology for the Studio chat's own Resources — **platform code,
 * not user data**: a fixed version defined here in source (D8), compiled **on
 * DevStudio** via the same `compileOntologyVersion` Galaxy uses (so the ADR-006
 * relationship/embed-guard threads identically), and mounted lazily through the
 * Worker Loader exactly like the tool-args facet. It is NOT a Galaxy ontology
 * version and never routes through Galaxy.
 *
 * `Turn.session` is authored as a reference to the `Session` ontology type — the
 * to-one relationship Child 2 will subscribe on. The write shape rewrites it to a
 * by-id `string`; embedding an object there is a loud ADR-006 error.
 *
 * ⚠️ Sentinel-version contract (review n1): the version is stamped into every
 * snapshot's `meta.ontologyVersion`. Editing these types is a BREAKING change —
 * bump {@link SESSION_TURN_ONTOLOGY_VERSION} *and* wipe DevStudio's resource
 * snapshots (there is no Galaxy version-registry / migration chain for it).
 */

import { compileOntologyVersion } from './galaxy';
import { getParserValidatorFacet } from '@lumenize/ts-runtime-parser-validator';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator';

/** The fixed, code-defined ontology version for the Session/Turn data plane.
 *  Changes only on deploy (which reboots the DO → `onStart` re-derives it). */
export const SESSION_TURN_ONTOLOGY_VERSION = 'session-turn-v1';

/**
 * Worker-Loader bundle id for the compiled Session/Turn validator. A fixed global
 * constant — the facet carries no tenant data, so it is safely shared across all
 * DevStudios. **Deliberately disjoint** from every other bundle-id namespace
 * (review M2 — a Worker-Loader collision silently serves the wrong validator =
 * validation bypass): the `nebula:` colon prefix cannot match the tool-args id
 * (`nebula-devstudio-tool-args-v1`) nor Star's `{universe.galaxy}/{version}` form
 * (whose pre-`/` segment always contains a `.`; this one's does not).
 */
export const SESSION_TURN_BUNDLE_ID = 'nebula:devstudio-resource-ontology/v1';

/**
 * The Session/Turn ontology, in source (ADR-001 — TS types ARE the schema).
 * Minimal for Child 1; Child 3 enriches. `Turn.session: Session` is the to-one
 * relationship (write shape: a by-id `string`).
 */
export const SESSION_TURN_TYPES = [
  'interface Session { title: string }',
  'interface Turn { session: Session; role: string; content: string }',
].join('\n');

/**
 * Build the `getOntology()` provider the {@link ResourceDataPlane} consumes on
 * DevStudio: compiles the fixed Session/Turn ontology on this DO (via
 * `compileOntologyVersion`) and mounts the validator through the Worker Loader.
 * The compile thunk only runs on a cold Worker-Loader build (cached by bundleId);
 * the version is server-sourced, never client-supplied.
 */
export function createResourceOntologyProvider(
  ctx: DurableObjectState,
  loader: WorkerLoader,
): () => { version: string; facet: ParserValidator } {
  return () => {
    const facet = getParserValidatorFacet(
      ctx,
      loader,
      SESSION_TURN_BUNDLE_ID,
      () => compileOntologyVersion({
        version: SESSION_TURN_ONTOLOGY_VERSION,
        types: SESSION_TURN_TYPES,
      }).validatorBundle,
    );
    return { version: SESSION_TURN_ONTOLOGY_VERSION, facet };
  };
}
