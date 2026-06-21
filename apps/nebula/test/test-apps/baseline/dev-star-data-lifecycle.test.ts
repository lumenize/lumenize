/**
 * Dev Star — P3: in-dev data lifecycle (additive preserved / breaking reset).
 *
 * Additive ontology edits preserve dev data for free (reads return stored values
 * verbatim; `@default` fills only on the next write). A breaking edit invalidates
 * stored snapshots, which we do NOT migrate — `resetDevData()` wipes the sandbox
 * (full `deleteAll` + `onStart` re-init) and the user-developer rebuilds. The
 * reset capability exists ONLY on `DevStar`.
 *
 * @see tasks/dev-star.md § P3, § In-dev data lifecycle
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID, Star, DevStar, requireAdmin } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/nebula';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { setDebugSink, clearDebugSink, type DebugSink } from '@lumenize/debug';
import {
  createAuthenticatedClient,
  browserLogin,
  createSubject,
  uniqueGalaxyScope,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2_ADDITIVE = `
  interface Todo {
    title: string;
    done: boolean;
    /** @default "red" */
    color?: string;
  }
`;
const TODO_V2_BREAKING = `interface Todo { title: string; done: boolean; priority: string; }`;

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}
async function devAdminClient(galaxy: string, dev: string) {
  return createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com');
}
type ApplyMarker = { namespace: string; data?: { instanceName?: string; version?: string } };
async function waitForApply(entries: ApplyMarker[], dev: string, version: string) {
  await vi.waitFor(() => {
    expect(entries.some(e => e.namespace === 'nebula.Star.applyFetchedState'
      && e.data?.instanceName === dev && e.data?.version === version)).toBe(true);
  });
}

describe('Dev Star P3 — in-dev data lifecycle', () => {
  it('additive edit: reads return the stored value verbatim (no read-time fill); @default fills on write', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V1 });
    await waitForSuccess(client);

    // Create a Todo under v1 (no `color` field exists yet).
    const rid = generateUuid();
    client.callDevStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    // v2 — ADDITIVE: a new optional `color` with @default "red". Eager-apply it.
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v2', types: TODO_V2_ADDITIVE });
    await waitForSuccess(client);
    const entries: ApplyMarker[] = [];
    const sink: DebugSink = (e) => { entries.push(e as ApplyMarker); };
    setDebugSink(sink);
    try {
      client.callDevStarDeployToDev(dev);
      await waitForResult(client);
      await waitForApply(entries, dev, 'v2');
    } finally {
      clearDebugSink();
    }

    // Read the PRE-EDIT snapshot at v2 → stored value verbatim, NO `color`
    // (reads never re-validate or fill defaults).
    client.callDevStarRead(dev, 'v2', rid);
    const before = await waitForSuccess(client) as Snapshot;
    expect((before.value as { color?: string }).color).toBeUndefined();

    // Write it back at v2 → @default fills `color: 'red'` (write path, v2 facet).
    client.callDevStarTransaction(dev, 'v2', {
      [rid]: { op: 'put', eTag: before.meta.eTag, value: { title: 'a', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client.callDevStarRead(dev, 'v2', rid);
    const after = await waitForSuccess(client) as Snapshot;
    expect((after.value as { color?: string }).color).toBe('red');

    client[Symbol.dispose]();
  });

  it('resetDevData wipes the sandbox and re-inits (M2)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V1 });
    await waitForSuccess(client);

    const rid = generateUuid();
    client.callDevStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'x', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client.callDevStarInspectReset(dev);
    let census = await waitForSuccess(client) as { snapshotCount: number; nodeCount: number; orphanCount: number };
    expect(census.snapshotCount).toBe(1);

    client.callDevStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();

    // Snapshots emptied; Nodes re-seeds ROOT only; no FK orphans.
    client.callDevStarInspectReset(dev);
    census = await waitForSuccess(client) as { snapshotCount: number; nodeCount: number; orphanCount: number };
    expect(census.snapshotCount).toBe(0);
    expect(census.nodeCount).toBe(1);
    expect(census.orphanCount).toBe(0);

    // The DO + registration survive: the resource is gone, and the re-init'd
    // schema accepts a fresh write.
    client.callDevStarRead(dev, 'v1', rid);
    expect(await waitForSuccess(client)).toBeNull();

    client[Symbol.dispose]();
  });

  it('resetDevData and deployToDev are admin-gated; a non-admin {u}.{g}.dev caller is rejected (B1)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client: admin } = await devAdminClient(galaxy, dev);
    admin.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V1 });
    await waitForSuccess(admin);

    // Non-admin galaxy member (invited subject) refreshed to the dev activeScope:
    // valid aud (onBeforeCall passes), but no admin claim.
    const adminBrowser = new Browser();
    const { accessToken } = await browserLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
    await createSubject(adminBrowser, galaxy, accessToken, 'user@example.com');
    const { client: user } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'user@example.com',
    );

    user.callDevStarResetDevData(dev);
    await waitForResult(user);
    expect(user.lastError).toContain('Admin access required');

    user.callDevStarDeployToDev(dev);
    await waitForResult(user);
    expect(user.lastError).toContain('Admin access required');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('resetDevData on a NON-.dev Star throws + wipes nothing (runtime .dev guard — Phase 3.5c)', async () => {
    // Phase 3.5c moved resetDevData DevStar→base Star (Decision 2), gated only by a
    // runtime segment-precise .dev check. This is the SECOND operand of the guard
    // (the instance-name operand, alongside B1's admin operand — testing.md compound-
    // condition rule). Drive it against the STAR binding with a prod tenant slug.
    const { galaxy, starA } = uniqueGalaxyScope();
    expect(starA.split('.')[2]).not.toBe('dev');   // fixture sanity: a non-dev tenant
    const { client } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, starA, 'admin@example.com',
    );

    // Seed survivable state (config KV) — deleteAll() would wipe it.
    client.callStarSetConfig(starA, 'survives', 'yes');
    await waitForSuccess(client);

    // Admin caller (requireAdmin passes) but the .dev guard throws. Capable-of-failing:
    // mutating the guard to always-pass → deleteAll runs → the config below is gone.
    client.callStarResetDevData(starA);
    await waitForResult(client);
    expect(client.lastError).toMatch(/only permitted on the \.dev sandbox Star/);

    // Wipes nothing — the throw is BEFORE blockConcurrencyWhile/deleteAll, so the
    // seeded key survives (a mutated always-pass guard → deleteAll → it's gone).
    client.callStarGetConfig(starA);
    expect(await waitForSuccess(client)).toMatchObject({ survives: 'yes' });

    client[Symbol.dispose]();
  });

  it('reset effect: pre-reset resource reads null and a pre-wipe node is absent (caches rebuilt); no FK orphans', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V1 });
    await waitForSuccess(client);

    // A child node + a resource attached to it.
    client.callDevStarCreateNode(dev, ROOT_NODE_ID, 'child', 'Child');
    const childNodeId = await waitForSuccess(client) as number;
    const rid = generateUuid();
    client.callDevStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: childNodeId, value: { title: 'x', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client.callDevStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();

    // (a) The resource is gone (read → null).
    client.callDevStarRead(dev, 'v1', rid);
    expect(await waitForSuccess(client)).toBeNull();

    // The pre-wipe node is absent — NodeNotFoundError is thrown by
    // #requireNodeExists BEFORE the admin bypass, so a stale DagTree cache
    // (node still present) would NOT throw → this is capable-of-failing on
    // cache-rebuild.
    client.callDevStarGetEffectivePermission(dev, childNodeId);
    await waitForResult(client);
    expect(client.lastError).toMatch(/not found/i);

    // (c) No Snapshots → Nodes FK orphans.
    client.callDevStarInspectReset(dev);
    const census = await waitForSuccess(client) as { orphanCount: number };
    expect(census.orphanCount).toBe(0);

    client[Symbol.dispose]();
  });

  it('reset effect: a pre-reset non-admin read grant is revoked post-reset (permission cache rebuilt)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client: admin } = await devAdminClient(galaxy, dev);
    admin.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V1 });
    await waitForSuccess(admin);

    const adminBrowser = new Browser();
    const { accessToken } = await browserLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
    await createSubject(adminBrowser, galaxy, accessToken, 'user@example.com');
    const { client: user, payload: userPayload } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'user@example.com',
    );
    const userSub = userPayload.sub;

    // Admin creates a resource at ROOT and grants the non-admin `read` on ROOT.
    const rid = generateUuid();
    admin.callDevStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'x', done: false } },
    });
    expect((await waitForSuccess(admin) as TransactionResult).ok).toBe(true);
    admin.callDevStarSetPermission(dev, ROOT_NODE_ID, userSub, 'read');
    await waitForSuccess(admin);

    // Positive control: the non-admin can read (grant in effect).
    user.callDevStarRead(dev, 'v1', rid);
    const snap = await waitForSuccess(user) as Snapshot;
    expect((snap.value as { title: string }).title).toBe('x');

    // Reset wipes the grant; admin re-creates a resource at ROOT (Snapshots were wiped).
    admin.callDevStarResetDevData(dev);
    await waitForResult(admin);
    expect(admin.lastError).toBeUndefined();
    admin.callDevStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'y', done: false } },
    });
    expect((await waitForSuccess(admin) as TransactionResult).ok).toBe(true);

    // The non-admin read is now DENIED — grant wiped + permission cache rebuilt.
    // Reader must be non-admin: requirePermission short-circuits on access.admin
    // before consulting the grant, so an admin reader would green vacuously.
    user.callDevStarRead(dev, 'v1', rid);
    await waitForResult(user);
    expect(user.lastError).toMatch(/permission required/i);

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('founder ROOT-admin grant: absent immediately after reset, reseeded on the next admin call (honest test)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client, payload } = await devAdminClient(galaxy, dev);
    const founderSub = payload.sub;
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V1 });
    await waitForSuccess(client);

    // Warm the dev Star so the founder grant + latch are seeded before reset.
    client.callDevStarWhoAmI(dev);
    await waitForSuccess(client);

    // Reset + probe in ONE call: the grant is ABSENT immediately after reset (the
    // reset call's own onBeforeCall ran with the latch set → no reseed; the
    // direct resetDevData call has no onBeforeCall to reseed either).
    client.callDevStarResetAndProbeRootAdmin(dev, founderSub);
    expect(await waitForSuccess(client)).toBe(false);

    // The NEXT admin call reseeds (latch wiped) → grant present.
    client.callDevStarInspectRootAdmin(dev, founderSub);
    expect(await waitForSuccess(client)).toBe(true);

    client[Symbol.dispose]();
  });

  it.skip('in-flight write vs reset: a write suspended at parseBatch resumes into the wiped tables (bounded edge)', async () => {
    // Documented demo contract (tasks/dev-star.md § Lifecycle note → Concurrency
    // assumption): blockConcurrencyWhile keeps the reset body atomic but does NOT
    // abort a concurrent doTransaction already suspended at its facet.parseBatch
    // await (that await opened the input gate). Such a write resumes AFTER the
    // wipe and commits a Snapshot into the freshly-emptied tables, possibly
    // orphaning Snapshot.nodeId → Nodes. For the demo this is bounded: the dev
    // sandbox is single-admin and Studio quiesces its in-flight write queue
    // before triggering reset. The server-side hardening (a generation counter
    // checked after parseBatch, before transactionSync, aborting writes whose
    // generation predates the last reset) is DEFERRED — it would touch the shared
    // production transaction path. Skipped (not deleted, per testing.md): the
    // edge is known + bounded, and a deterministic interleave at the parseBatch
    // await isn't reliably reproducible without that counter. Revive when it lands.
  });

  it('breaking eager-apply → reset loop: stale snapshot invalid under new version; reset; fresh write validates (M5)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V1 });
    await waitForSuccess(client);
    const rid = generateUuid();
    client.callDevStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    expect(r1.ok).toBe(true);
    const eTag1 = r1.ok ? r1.eTags[rid] : '';

    // v2 — BREAKING: a required `priority`. Eager-apply.
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v2', types: TODO_V2_BREAKING });
    await waitForSuccess(client);
    const entries: ApplyMarker[] = [];
    const sink: DebugSink = (e) => { entries.push(e as ApplyMarker); };
    setDebugSink(sink);
    try {
      client.callDevStarDeployToDev(dev);
      await waitForResult(client);
      await waitForApply(entries, dev, 'v2');
    } finally {
      clearDebugSink();
    }

    // The pre-edit snapshot is invalid under v2 — a put of its old shape (missing
    // required `priority`) fails validation.
    client.callDevStarTransaction(dev, 'v2', {
      [rid]: { op: 'put', eTag: eTag1, value: { title: 'a', done: false } },
    });
    const rBad = await waitForSuccess(client) as TransactionResult;
    expect(rBad.ok).toBe(false);
    if (!rBad.ok) expect(rBad.errors[rid].type).toBe('validation');

    // Reset → empty.
    client.callDevStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();

    // A fresh write satisfying v2 (includes `priority`) validates + commits.
    const rid2 = generateUuid();
    client.callDevStarTransaction(dev, 'v2', {
      [rid2]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'b', done: false, priority: 'high' } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client[Symbol.dispose]();
  });
});

// Walk a class's OWN prototype, returning the names of its mesh-callable methods
// whose guard satisfies `pred(guard)`. Copied from scope-isolation.test.ts (B5) —
// own-prototype-only, so it returns exactly the class's *added* @mesh methods.
function meshMethodsWhere(ctor: { prototype: object }, pred: (guard: unknown) => boolean): string[] {
  const proto = ctor.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if (!pred(getMeshGuard(fn))) continue;
    out.push(name);
  }
  return out.sort();
}
const nonAdminMeshMethods = (ctor: { prototype: object }) => meshMethodsWhere(ctor, (g) => g !== requireAdmin);
const adminMeshMethods = (ctor: { prototype: object }) => meshMethodsWhere(ctor, (g) => g === requireAdmin);

describe('Dev Star P3 — reset capability surface (Phase 3.5c relocation)', () => {
  it('resetDevData now lives on base Star.prototype, mesh-callable + admin-gated', () => {
    // Phase 3.5c moved the wipe DevStar→Star (Decision 2). Capable-of-failing: the
    // pre-move assertion (Star.prototype.resetDevData === undefined) is now INVERTED.
    const fn = (Star.prototype as unknown as Record<string, unknown>).resetDevData as (...a: unknown[]) => unknown;
    expect(typeof fn).toBe('function');
    expect(isMeshCallable(fn)).toBe(true);
    expect(getMeshGuard(fn)).toBe(requireAdmin);
    // DevStar no longer OWNS it (the structural containment is gone — replaced by the
    // runtime .dev guard + the freeze below); it inherits from Star.
    expect(Object.getOwnPropertyNames(DevStar.prototype)).not.toContain('resetDevData');
  });

  it('Star.prototype @mesh-surface-freeze: the admin-gated set equals the frozen allow-list', () => {
    // The post-collapse PRODUCTION surface (Star.prototype — the DevStar own-prototype
    // walk is now vacuous for resetDevData). resetDevData + setOntology + setStarConfig
    // are the admin-gated @mesh methods; a new one must be added deliberately +
    // re-reviewed. Mutation-validated: removing requireAdmin from resetDevData (or
    // setOntology) drops it from this set → != frozen list → RED.
    expect(adminMeshMethods(Star)).toEqual(['resetDevData', 'setOntology', 'setStarConfig']);
  });

  it('every @mesh method DevStar ADDS is admin-gated — nonAdminMeshMethods(DevStar) === []', () => {
    // DevStar's own prototype now adds only deployToDev (resetDevData moved to Star;
    // compileSFC deleted in Phase 4). @mesh(requireAdmin). Subsumed by the
    // Star.prototype walk above for resetDevData; this still guards DevStar's
    // remaining own surface until the class is deleted in Phase 4.
    expect(nonAdminMeshMethods(DevStar)).toEqual([]);
  });

  it('Star.applyFetchedState is NOT @mesh-callable — its safety is the absence of the decorator (P2)', () => {
    // applyFetchedState wraps #installState and is reachable only as an internal
    // continuation handler (the local executor). If it ever gained @mesh it would
    // become a remotely-callable, UNGUARDED ontology-install. "public, not @mesh" IS
    // the security boundary. Capable-of-failing: adding @mesh flips this RED.
    // (Contrast setOntology — the *gated* @mesh entry for the same install, above.)
    const fn = (Star.prototype as unknown as Record<string, unknown>).applyFetchedState;
    expect(typeof fn).toBe('function');
    expect(isMeshCallable(fn as (...a: unknown[]) => unknown)).toBe(false);
  });
});
