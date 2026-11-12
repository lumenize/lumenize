/**
 * The test Worker for `@lumenize/resources`: a host node composing the Resources plane as `Star`
 * does, beside Mesh's auth, so a test's Client logs in and reaches it as a page's Client does.
 *
 * The host serves one ontology version, compiled here on first use rather than pulled from a
 * Galaxy: a `Board`, and a `Note` whose `board` relationship a query follows. Every tier's page
 * connects to it under the `STAR` binding, the one `NebulaClient` names by default.
 */
import { defineRoutes, mesh, ScopedMeshDO } from '@lumenize/mesh';
import { Resources, ROOT_NODE_ID } from '@lumenize/resources';
import type {
  OntologySource, ResourcesHost, ResourcesRequests, ResourcesResults, TransactionResult, TreeSeed,
} from '@lumenize/resources';
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

  /** What this host declares in its tree: nothing, as a Star declares nothing. */
  protected treeSeed(): TreeSeed {
    return {};
  }

  protected ontologySource(): OntologySource {
    return {
      current: () => compiledRow(),
      // The loader caches by id across the Worker, so the id carries the host's name.
      bundleId: (version) => `${this.ctx.id.name ?? 'host'}/${version}`,
    };
  }

  /** The plane, for a subclass's fixtures. */
  protected get plane(): Resources {
    return this.#resources;
  }

  onStart(): void {
    this.#resources = new Resources(this.ctx, () => this.lmz, this.ontologySource(), undefined, { seed: this.treeSeed() });
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

  // ── Probes for `actUnderClaimsOf`, which only a host's own code calls (act-under-claims-of.test.ts).
  // A test calls them on the stub, so no call context is running: whatever the block reads came
  // from the stored record.

  /** The current `validFrom` of `resourceId`, read from storage. */
  currentValidFrom(resourceId: string): string | undefined {
    const row = this.ctx.storage.sql.exec(
      'SELECT validFrom FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1', resourceId).toArray()[0];
    return row?.validFrom as string | undefined;
  }

  /** Run a block under one snapshot's claims, and answer what it read, or what refused it. */
  probeActUnder(resourceId: string, validFrom: string, principal: string):
    { ran: boolean; claims?: Record<string, any>; error?: { name: string; message: string } } {
    let ran = false;
    try {
      const claims = this.#resources.actUnderClaimsOf(resourceId, validFrom, principal, () => {
        ran = true;
        return this.lmz.callContext.originAuth?.claims as Record<string, any> | undefined;
      });
      return { ran, claims };
    } catch (e) {
      return { ran, error: { name: (e as Error).name, message: (e as Error).message } };
    }
  }

  /** Create a `Board` at `nodeId` from inside the block, through the plane's own write path. */
  createUnder(resourceId: string, validFrom: string, principal: string, newId: string, nodeId: string): Promise<TransactionResult> {
    return this.#resources.actUnderClaimsOf(resourceId, validFrom, principal, () =>
      this.#resources.doTransaction({ [newId]: { op: 'create', typeName: 'Board', nodeId, value: { title: 'under a record' } } }, ''));
  }

  /** Whether the surface the `@mesh()`-decorated `resources` getter hands the wire has `member`. */
  requestsHas(member: string): boolean {
    return member in this.#resources.requests;
  }
}

/** A node under the seeded host's root where its local principal holds a protected `write`. */
export const GRANTED_NODE_ID = '00000000-0000-4000-8000-00000000000a';
/** A sibling of it where the principal holds nothing. */
export const BARE_NODE_ID = '00000000-0000-4000-8000-00000000000b';
/** The seeded host's local principal. */
export const SEEDED_PRINCIPAL = 'agent:test';

const SEED: TreeSeed = {
  nodes: [
    { nodeId: GRANTED_NODE_ID, parentNodeId: ROOT_NODE_ID, slug: 'granted', label: 'Granted' },
    { nodeId: BARE_NODE_ID, parentNodeId: ROOT_NODE_ID, slug: 'bare', label: 'Bare' },
  ],
  grants: [{ nodeId: GRANTED_NODE_ID, sub: SEEDED_PRINCIPAL, tier: 'write', protected: true }],
};

/**
 * A host that declares a seed, as a Galaxy does, with fixtures for what no Client can reach: the
 * rows a construction writes, and a write made as the host's local principal, which no product
 * path makes until a Galaxy's agent posts as itself. No route names its binding, so a test calls
 * the fixtures on its stub and stamps its name first, as a first mesh entry would.
 */
export class SeededHostDO extends ResourcesHostDO {
  protected override treeSeed(): TreeSeed {
    return SEED;
  }

  /** Stamp the node's name, which `lmz.asLocalPrincipal` builds the principal's claims from. */
  initForTest(instanceName: string): void {
    this.lmz.__init({ bindingName: 'SEEDED', instanceName });
  }

  /**
   * Construct the plane again over this object's storage, as a wake does, and count the rows that
   * construction writes. The counter sits on `sql.exec`, the one way the plane's parts write.
   */
  rowsWrittenBySecondConstruction(): number {
    let written = 0;
    const bound = (target: object, prop: string | symbol): unknown => {
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    const sql = new Proxy(this.ctx.storage.sql, {
      get: (target, prop) => prop !== 'exec' ? bound(target, prop) : (query: string, ...bindings: unknown[]) => {
        const cursor = target.exec(query, ...bindings);
        written += cursor.rowsWritten;
        return cursor;
      },
    });
    const storage = new Proxy(this.ctx.storage, { get: (target, prop) => prop === 'sql' ? sql : bound(target, prop) });
    const ctx = new Proxy(this.ctx, { get: (target, prop) => prop === 'storage' ? storage : bound(target, prop) });
    new Resources(ctx, () => this.lmz, this.ontologySource(), undefined, { seed: this.treeSeed() });
    return written;
  }

  /** Move the seeded `granted` node from under the root to under `bare`, as an admin's move
   *  would leave the tree, and answer every edge as stored. */
  moveGrantedUnderBare(): string[] {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM Edges WHERE childNodeId = ?', GRANTED_NODE_ID);
    sql.exec('INSERT INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)', BARE_NODE_ID, GRANTED_NODE_ID);
    return this.edges();
  }

  /** Every edge as stored, `parent>child`, sorted. */
  edges(): string[] {
    return this.ctx.storage.sql.exec('SELECT parentNodeId, childNodeId FROM Edges').toArray()
      .map((r) => `${r.parentNodeId as string}>${r.childNodeId as string}`).sort();
  }

  /** The seeded rows as stored: each node's slug, and each grant. */
  seededRows(): { slugs: string[]; grants: Array<{ nodeId: string; sub: string; permission: string }> } {
    const sql = this.ctx.storage.sql;
    return {
      slugs: sql.exec('SELECT slug FROM Nodes ORDER BY slug').toArray().map((r) => r.slug as string),
      grants: sql.exec('SELECT nodeId, sub, permission FROM Permissions ORDER BY nodeId').toArray() as
        Array<{ nodeId: string; sub: string; permission: string }>,
    };
  }

  /** Create a `Board` at `nodeId` as the host's local principal, through the plane's own write path. */
  createAsPrincipal(resourceId: string, nodeId: string): Promise<TransactionResult> {
    return this.lmz.asLocalPrincipal(SEEDED_PRINCIPAL, () =>
      this.plane.doTransaction({ [resourceId]: { op: 'create', typeName: 'Board', nodeId, value: { title: 'by the principal' } } }, ''));
  }

  /** Create a `Board` at `nodeId` as the local principal through `ensureResource`, the write host
   *  code makes with nobody waiting on its answer. Resolves `'created'`, or the refusal's message. */
  ensureAsPrincipal(resourceId: string, nodeId: string): Promise<string> {
    return this.lmz.asLocalPrincipal(SEEDED_PRINCIPAL, () =>
      this.plane.ensureResource(resourceId, 'Board', nodeId, { title: 'ensured' })
        .then(() => 'created', (error: Error) => error.message));
  }

  /** Who the stored snapshot of `resourceId` records as having written it. */
  recordedSubject(resourceId: string): string | undefined {
    const row = this.ctx.storage.sql.exec('SELECT recordedClaims FROM Snapshots WHERE resourceId = ?', resourceId).toArray()[0];
    return row ? (JSON.parse(row.recordedClaims as string) as { sub?: string }).sub : undefined;
  }
}

const TIERS = { universe: 'STAR', galaxy: 'STAR', star: 'STAR' } as const;

/** Every binding this Worker's Clients may name; any other is refused at its host's Gateway. */
defineRoutes({
  STAR: { tier: ['universe', 'galaxy', 'star'], hosts: true },
  PROFILE: 'unscoped',
  AUTH_FACADE: 'worker',
});

export const AuthFacade = authFacadeFor(TIERS);

export default {
  fetch: meshTestFetch(TIERS),
};
