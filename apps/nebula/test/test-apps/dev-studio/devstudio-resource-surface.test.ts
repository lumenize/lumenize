/**
 * DevStudio resource data-plane surface (Child 1, nebula-devstudio-data-plane.md Phase 3).
 *
 * Two things, neither needing a Gateway/client (the real client resource round-trip
 * + the non-admin-DAG-granted read/write + version-stamp are Phase 5):
 *  1. **Frozen @mesh surface (m5):** the new resource methods are non-admin
 *     (`@mesh()`, DAG-gated — D4); codegen/source methods stay `requireAdmin`.
 *  2. **Facet behavior on DevStudio:** the composed Session/Message provider mounts +
 *     enforces the ADR-006 embed-guard (SC3), coexists with the tool-args facet in
 *     one DO without bundleId cross-wiring (M2), and survives an `onStart` re-init
 *     with an unchanged version (M3).
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { DevStudio } from '../../../src/dev-studio';
import { requireAdmin } from '../../../src/nebula-do';
import { SESSION_MESSAGE_ONTOLOGY_VERSION } from '../../../src/devstudio-resource-ontology';

// ─── driver — direct in-DO call ────────────────────────────────────────────
// These `*ForTest` methods are PURE (they read `this.ctx`/`this.env.LOADER`, no callContext, no
// cross-DO call), so run them directly in-DO to get the RETURN VALUE. Driving them through the mesh
// `__executeOperation` path is no longer usable here: it EARLY-ACKS (returns `{$ack}`) and runs the
// chain in a detached `waitUntil` task, so the result would travel via fire-back, unobservable from
// a bare envelope. The admin `@mesh(requireAdmin)` guard is not what these facet-behavior tests
// exercise (the m5/requireAdmin *surface* is frozen statically above), so bypassing it is correct.
const uniqueDevScope = () => `${crypto.randomUUID()}.app.dev`;
async function callStudio(instance: string, method: string, args: unknown[] = []) {
  const stub = (env as any).DEV_STUDIO.getByName(instance);
  return (runInDurableObject as any)(stub, (inst: any) => inst[method](...args));
}

// Walk DevStudio's OWN prototype for mesh-callable methods, partitioned by guard.
function meshMethods(admin: boolean): string[] {
  const proto = DevStudio.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if ((getMeshGuard(fn) === requireAdmin) === admin) out.push(name);
  }
  return out.sort();
}

describe('DevStudio @mesh surface freeze (m5)', () => {
  // Freeze the non-admin surface: a resource method accidentally shipped with
  // requireAdmin LEAVES this set (→ red); a codegen method accidentally shipped
  // non-admin ENTERS it (→ red). Both gate sets are thus pinned.
  it('non-admin @mesh surface == the resource surface, exactly', () => {
    expect(meshMethods(false)).toEqual(
      ['dagTree', 'onBroadcastResult', 'onQueryBroadcastResult',
       // Query-subscriber-list (presence). Non-admin BY DESIGN: ADR-008 extends full-org-tree
       // visibility to presence — who is actively subscribed is Star-reachability-gated, not
       // admin-gated. These landed with the presence feature and this freeze list was never
       // updated; the drift predates tasks/nebula-confine-admin-bypass.md (which does not touch
       // dev-studio.ts) and is recorded here rather than left red.
       'onQuerySubscriberListBroadcastResult', 'subscribeQuerySubscribers', 'unsubscribeQuerySubscribers',
       'read', 'subscribe',
       'subscribeQuery', 'transaction', 'unsubscribe', 'unsubscribeQuery'].sort(),
    );
  });

  it('codegen/source methods stay requireAdmin', () => {
    const admin = meshMethods(true);
    for (const m of [
      'writeSource', 'readSource', 'getSourceTree',
      'compileAndInstallOntology', 'applyOntologyChange',
      'ensureUp', 'syncToDevContainer', 'chat', 'warmPreview',
    ]) {
      expect(admin).toContain(m);
    }
  });
});

describe('DevStudio Session/Message facet (composed provider)', () => {
  const validTurn = { session: 'sess-1', role: 'user', content: 'hello' };

  it('SC3 + M2: accepts a Message whose session is an id string (both facets mounted → no cross-wiring)', async () => {
    const dev = uniqueDevScope();
    const r = await callStudio(dev, 'parseSessionTurnForTest', ['Message', validTurn]);
    expect(r.valid).toBe(true);
  });

  it('SC3: rejects an embedded session object with the ADR-006 by-id (embed) guard', async () => {
    const dev = uniqueDevScope();
    const embedded = { session: { title: 'embedded not an id' }, role: 'user', content: 'x' };
    const r = await callStudio(dev, 'parseSessionTurnForTest', ['Message', embedded]);
    expect(r.valid).toBe(false);
    const err = r.errors.find((e: { path: string }) => e.path === '$input.session');
    expect(err).toBeDefined();
    // The loud warning explains the by-id relationship contract (names field + target).
    expect(err.description).toMatch(/reference by id/i);
  });

  it('Child 2 Phase 0: the getOntology() seam carries relationships (Message.session is to-one)', async () => {
    const dev = uniqueDevScope();
    const rels = await callStudio(dev, 'resourceRelationshipsForTest') as
      Record<string, Record<string, { target: string; cardinality: string }>>;
    // Capable-of-failing: drop `relationships` from the provider closure → this is
    // `undefined` and the `.Message.session` access throws (red). subscribeQuery field
    // validation (Phase 3) has nothing to check without this.
    expect(rels.Message.session).toMatchObject({ target: 'Session', cardinality: 'one' });
  });

  it('M3: ontology version is the fixed constant and survives an onStart re-init', async () => {
    const dev = uniqueDevScope();
    expect(await callStudio(dev, 'resourceOntologyVersionForTest')).toBe(SESSION_MESSAGE_ONTOLOGY_VERSION);
    await callStudio(dev, 'reInitForTest');
    // Re-derivable from the platform constant — a write still validates, version unchanged.
    const r = await callStudio(dev, 'parseSessionTurnForTest', ['Message', validTurn]);
    expect(r.valid).toBe(true);
    expect(await callStudio(dev, 'resourceOntologyVersionForTest')).toBe(SESSION_MESSAGE_ONTOLOGY_VERSION);
  });
});
