/**
 * The test Worker for `@lumenize/resources`: a host node composing the Resources plane as `Star`
 * does, beside Mesh's auth, so a test's Client logs in and reaches it as a page's Client does.
 *
 * The host serves one ontology version, compiled here on first use rather than pulled from a
 * Galaxy: a `Board`, and a `Note` whose `board` relationship a query follows. Every tier's page
 * connects to it under the `STAR` binding, the one `NebulaClient` names by default.
 */
import { mesh, ScopedMeshDO } from '@lumenize/mesh';
import { Resources } from '@lumenize/resources';
import type { OntologySource, ResourcesHost, ResourcesRequests, ResourcesResults } from '@lumenize/resources';
import type { OntologyVersionRow } from '@lumenize/resources/ontology-version';
import { extractTypeMetadata, generateParseModule } from '@lumenize/ts-runtime-parser-validator/compile';
// Mesh's own test auth, so a login here runs the Registry, its routes and the hosted upgrade exactly
// as Mesh's suites do.
import { authFacadeFor, meshTestFetch } from '../../mesh/test/support/test-auth';

export { AuthRegistry, Profile } from '../../mesh/test/support/test-auth';

/** The one version the host serves. */
export const ONTOLOGY_VERSION = 'v1';

/** Its types: a `Note` belongs to a `Board`, so `Note where board == …` is a query. */
const TYPES = 'interface Board { title: string; }\ninterface Note { title: string; board: Board; }';

/** Compiled once per isolate, on the first op that needs it. */
let row: OntologyVersionRow | undefined;
function compiledRow(): OntologyVersionRow {
  if (!row) {
    const md = extractTypeMetadata(TYPES);
    row = {
      version: ONTOLOGY_VERSION,
      types: TYPES,
      validatorBundle: generateParseModule(md.writeShapeTypeDefinitions, md.relationships),
      relationships: md.relationships,
    };
  }
  return row;
}

/** A host node composing the Resources plane, with `Star`'s two doors. */
export class ResourcesHostDO extends ScopedMeshDO<Env> implements ResourcesHost {
  #resources!: Resources;

  onStart(): void {
    const source: OntologySource = {
      current: () => compiledRow(),
      // The loader caches by id across the Worker, so the id carries the host's name.
      bundleId: (version) => `${this.ctx.id.name ?? 'host'}/${version}`,
    };
    this.#resources = new Resources(this.ctx, () => this.lmz, source);
  }

  /** The plane's request surface, as `Star`'s one `@mesh()` door returns it. */
  @mesh()
  get resources(): ResourcesRequests {
    return this.#resources.requests;
  }

  /** The plane's response-leg surface; no `@mesh()`, as on `Star`. */
  get resourcesResults(): ResourcesResults {
    return this.#resources.results;
  }
}

const TIERS = { universe: 'STAR', galaxy: 'STAR', star: 'STAR' } as const;

export const AuthFacade = authFacadeFor(TIERS);

export default {
  fetch: meshTestFetch(TIERS),
};
