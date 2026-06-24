/**
 * Dev-data lifecycle (additive preserved / breaking reset) on the `.dev` Star.
 *
 * Post-collapse (Decision 2) the dev Star is a plain `Star` at a `{u}.{g}.dev`
 * instance — no `DevStar` class. Additive ontology edits preserve dev data for free
 * (reads return stored values verbatim; `@default` fills only on the next write). A
 * breaking edit invalidates stored snapshots, which we do NOT migrate — `resetDevData()`
 * wipes the sandbox (full `deleteAll` + `onStart` re-init, hard-guarded to `.dev`
 * instances) and the user-developer rebuilds. Ontology is applied via
 * `setOntology` (DevStudio's dev path); the Galaxy lazy-pull was retired in Phase 4.
 *
 * @see tasks/nebula-studio.md § Dev-data reset
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID, Star, requireAdmin } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/nebula';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
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
/** Apply an ontology version to the `.dev` Star (the setOntology path that replaced
 *  append + lazy-pull / deployToDev). */
async function applyOntology(client: NebulaClientTest, dev: string, version: string, types: string) {
  client.callStarApplyOntology(dev, { version, types });
  await waitForSuccess(client);
}

describe('Dev-data lifecycle — in-dev data (.dev Star)', () => {
  it('additive edit: reads return the stored value verbatim (no read-time fill); @default fills on write', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    await applyOntology(client, dev, 'v1', TODO_V1);

    // Create a Todo under v1 (no `color` field exists yet).
    const rid = generateUuid();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    // v2 — ADDITIVE: a new optional `color` with @default "red". Apply it.
    await applyOntology(client, dev, 'v2', TODO_V2_ADDITIVE);

    // Read the PRE-EDIT snapshot at v2 → stored value verbatim, NO `color`
    // (reads never re-validate or fill defaults).
    client.callStarRead(dev, 'v2', rid);
    const before = await waitForSuccess(client) as Snapshot;
    expect((before.value as { color?: string }).color).toBeUndefined();

    // Write it back at v2 → @default fills `color: 'red'` (write path, v2 facet).
    client.callStarTransaction(dev, 'v2', {
      [rid]: { op: 'put', eTag: before.meta.eTag, value: { title: 'a', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client.callStarRead(dev, 'v2', rid);
    const after = await waitForSuccess(client) as Snapshot;
    expect((after.value as { color?: string }).color).toBe('red');

    client[Symbol.dispose]();
  });

  it('resetDevData wipes the sandbox and re-inits (M2)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    await applyOntology(client, dev, 'v1', TODO_V1);

    const rid = generateUuid();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'x', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client.callStarInspectReset(dev);
    let census = await waitForSuccess(client) as { snapshotCount: number; nodeCount: number; orphanCount: number };
    expect(census.snapshotCount).toBe(1);

    client.callStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();

    // Snapshots emptied; Nodes re-seeds ROOT only; no FK orphans.
    client.callStarInspectReset(dev);
    census = await waitForSuccess(client) as { snapshotCount: number; nodeCount: number; orphanCount: number };
    expect(census.snapshotCount).toBe(0);
    expect(census.nodeCount).toBe(1);
    expect(census.orphanCount).toBe(0);

    // resetDevData wipes the ontology too (full deleteAll); re-apply it as Flow 1b does
    // (reset → setOntology). The DO + registration survive: the resource is gone, and
    // the re-init'd schema accepts a fresh read.
    await applyOntology(client, dev, 'v1', TODO_V1);
    client.callStarRead(dev, 'v1', rid);
    expect(await waitForSuccess(client)).toBeNull();

    client[Symbol.dispose]();
  });

  it('resetDevData is admin-gated; a non-admin {u}.{g}.dev caller is rejected (B1)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client: admin } = await devAdminClient(galaxy, dev);
    await applyOntology(admin, dev, 'v1', TODO_V1);

    // Non-admin galaxy member (invited subject) refreshed to the dev activeScope:
    // valid aud (onBeforeCall passes), but no admin claim.
    const adminBrowser = new Browser();
    const { accessToken } = await browserLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
    await createSubject(adminBrowser, galaxy, accessToken, 'user@example.com');
    const { client: user } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'user@example.com',
    );

    user.callStarResetDevData(dev);
    await waitForResult(user);
    expect(user.lastError).toContain('Admin access required');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('resetDevData on a NON-.dev Star throws + wipes nothing (runtime .dev guard)', async () => {
    // The wipe ships on every Star (Decision 2), gated only by a runtime segment-precise
    // .dev check. This is the SECOND operand of the guard (the instance-name operand,
    // alongside B1's admin operand — testing.md compound-condition rule). Drive it
    // against a prod tenant slug.
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
    await applyOntology(client, dev, 'v1', TODO_V1);

    // A child node + a resource attached to it.
    client.callStarCreateNode(dev, ROOT_NODE_ID, 'child', 'Child');
    const childNodeId = await waitForSuccess(client) as number;
    const rid = generateUuid();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: childNodeId, value: { title: 'x', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client.callStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();

    // Re-apply the ontology after the wipe (Flow 1b: reset → setOntology).
    await applyOntology(client, dev, 'v1', TODO_V1);

    // (a) The resource is gone (read → null).
    client.callStarRead(dev, 'v1', rid);
    expect(await waitForSuccess(client)).toBeNull();

    // The pre-wipe node is absent — NodeNotFoundError is thrown by #requireNodeExists
    // BEFORE the admin bypass, so a stale DagTree cache (node still present) would NOT
    // throw → this is capable-of-failing on cache-rebuild.
    client.callStarGetEffectivePermission(dev, childNodeId);
    await waitForResult(client);
    expect(client.lastError).toMatch(/not found/i);

    // (c) No Snapshots → Nodes FK orphans.
    client.callStarInspectReset(dev);
    const census = await waitForSuccess(client) as { orphanCount: number };
    expect(census.orphanCount).toBe(0);

    client[Symbol.dispose]();
  });

  it('reset effect: a pre-reset non-admin read grant is revoked post-reset (permission cache rebuilt)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client: admin } = await devAdminClient(galaxy, dev);
    await applyOntology(admin, dev, 'v1', TODO_V1);

    const adminBrowser = new Browser();
    const { accessToken } = await browserLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
    await createSubject(adminBrowser, galaxy, accessToken, 'user@example.com');
    const { client: user, payload: userPayload } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'user@example.com',
    );
    const userSub = userPayload.sub;

    // Admin creates a resource at ROOT and grants the non-admin `read` on ROOT.
    const rid = generateUuid();
    admin.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'x', done: false } },
    });
    expect((await waitForSuccess(admin) as TransactionResult).ok).toBe(true);
    admin.callStarSetPermission(dev, ROOT_NODE_ID, userSub, 'read');
    await waitForSuccess(admin);

    // Positive control: the non-admin can read (grant in effect).
    user.callStarRead(dev, 'v1', rid);
    const snap = await waitForSuccess(user) as Snapshot;
    expect((snap.value as { title: string }).title).toBe('x');

    // Reset wipes the grant; re-apply the ontology (Flow 1b) + admin re-creates a
    // resource at ROOT (Snapshots were wiped).
    admin.callStarResetDevData(dev);
    await waitForResult(admin);
    expect(admin.lastError).toBeUndefined();
    await applyOntology(admin, dev, 'v1', TODO_V1);
    admin.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'y', done: false } },
    });
    expect((await waitForSuccess(admin) as TransactionResult).ok).toBe(true);

    // The non-admin read is now DENIED — grant wiped + permission cache rebuilt.
    // Reader must be non-admin: requirePermission short-circuits on access.admin before
    // consulting the grant, so an admin reader would green vacuously.
    user.callStarRead(dev, 'v1', rid);
    await waitForResult(user);
    expect(user.lastError).toMatch(/permission required/i);

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('founder ROOT-admin grant: absent immediately after reset, reseeded on the next admin call (honest test)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client, payload } = await devAdminClient(galaxy, dev);
    const founderSub = payload.sub;
    await applyOntology(client, dev, 'v1', TODO_V1);

    // Warm the dev Star so the founder grant + latch are seeded before reset.
    client.callStarWhoAmI(dev);
    await waitForSuccess(client);

    // Reset + probe in ONE call: the grant is ABSENT immediately after reset (the reset
    // call's own onBeforeCall ran with the latch set → no reseed; the direct
    // resetDevData call has no onBeforeCall to reseed either).
    client.callStarResetAndProbeRootAdmin(dev, founderSub);
    expect(await waitForSuccess(client)).toBe(false);

    // The NEXT admin call reseeds (latch wiped) → grant present.
    client.callStarInspectRootAdmin(dev, founderSub);
    expect(await waitForSuccess(client)).toBe(true);

    client[Symbol.dispose]();
  });

  // The bounded "in-flight write vs reset" edge (a doTransaction suspended at
  // facet.parseBatch resumes AFTER resetDevData's wipe and commits a Snapshot into the
  // emptied tables, possibly orphaning Snapshot.nodeId → Nodes) is bounded for the demo
  // (single-admin; Studio quiesces its write queue before reset). The server-side hardening
  // (a generation counter) is deferred → tasks/backlog.md § Testing & Quality; tracked there
  // rather than as a placeholder test here.

  it('breaking edit → reset loop: stale snapshot invalid under new version; reset; fresh write validates (M5)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    await applyOntology(client, dev, 'v1', TODO_V1);
    const rid = generateUuid();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    expect(r1.ok).toBe(true);
    const eTag1 = r1.ok ? r1.eTags[rid] : '';

    // v2 — BREAKING: a required `priority`. Apply.
    await applyOntology(client, dev, 'v2', TODO_V2_BREAKING);

    // The pre-edit snapshot is invalid under v2 — a put of its old shape (missing
    // required `priority`) fails validation.
    client.callStarTransaction(dev, 'v2', {
      [rid]: { op: 'put', eTag: eTag1, value: { title: 'a', done: false } },
    });
    const rBad = await waitForSuccess(client) as TransactionResult;
    expect(rBad.ok).toBe(false);
    if (!rBad.ok) expect(rBad.errors[rid].type).toBe('validation');

    // Reset → empty; re-apply v2 (Flow 1b: reset → setOntology the new ontology).
    client.callStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();
    await applyOntology(client, dev, 'v2', TODO_V2_BREAKING);

    // A fresh write satisfying v2 (includes `priority`) validates + commits.
    const rid2 = generateUuid();
    client.callStarTransaction(dev, 'v2', {
      [rid2]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'b', done: false, priority: 'high' } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client[Symbol.dispose]();
  });
});

// Walk a class's OWN prototype, returning its mesh-callable methods whose guard is
// requireAdmin. Copied from scope-isolation.test.ts (B5).
function adminMeshMethods(ctor: { prototype: object }): string[] {
  const proto = ctor.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if (getMeshGuard(fn) !== requireAdmin) continue;
    out.push(name);
  }
  return out.sort();
}

describe('resetDevData capability surface (Star.prototype)', () => {
  it('resetDevData lives on base Star.prototype, mesh-callable + admin-gated', () => {
    const fn = (Star.prototype as unknown as Record<string, unknown>).resetDevData as (...a: unknown[]) => unknown;
    expect(typeof fn).toBe('function');
    expect(isMeshCallable(fn)).toBe(true);
    expect(getMeshGuard(fn)).toBe(requireAdmin);
  });

  it('Star.prototype @mesh-surface-freeze: the admin-gated set equals the frozen allow-list', () => {
    // The post-collapse PRODUCTION surface. resetDevData + setOntology + setStarConfig are
    // the admin-gated @mesh methods; a new one must be added deliberately + re-reviewed.
    // Mutation-validated: removing requireAdmin from resetDevData (or setOntology) drops it
    // from this set → != frozen list → RED.
    expect(adminMeshMethods(Star)).toEqual(['resetDevData', 'setOntology', 'setStarConfig']);
  });
});
