/**
 * Dev-data lifecycle (additive preserved / breaking reset) on the `.dev` Star.
 *
 * Post-collapse (Decision 2) the dev Star is a plain `Star` at a `{u}.{g}.dev`
 * instance — no `DevStar` class. Additive ontology edits preserve dev data for free
 * (reads return stored values verbatim; `@default` fills only on the next write). A
 * breaking edit invalidates stored snapshots, which we do NOT migrate — `resetDevData()`
 * wipes the sandbox (the plane's wipe — every table and key it owns, refused off `.dev`)
 * and the user-developer rebuilds. Ontology is installed through
 * `resourcesResults.onOntologyPulled`, where a Galaxy's answer lands.
 *
 * @see tasks/nebula-studio.md § Dev-data reset
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/resources';
import { Star, requireDominionHere } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/resources';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { meshEntries } from '../mesh-surface';
import { universeAdminClient, createInvitedClient, foundAndLogin, createSubject, uniqueGalaxyScope } from '../../test-helpers';
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
  return universeAdminClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com');
}
/** Install an ontology version on the `.dev` Star, the way a pulled row installs. */
async function installOntology(client: NebulaClientTest, dev: string, version: string, types: string) {
  client.callStarInstallOntology(dev, { version, types });
  await waitForSuccess(client);
}

describe('Dev-data lifecycle — in-dev data (.dev Star)', () => {
  it('additive edit: reads return the stored value verbatim (no read-time fill); @default fills on write', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    await installOntology(client, dev, 'v1', TODO_V1);

    // Create a Todo under v1 (no `color` field exists yet).
    const rid = crypto.randomUUID();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    // v2 — ADDITIVE: a new optional `color` with @default "red". Apply it.
    await installOntology(client, dev, 'v2', TODO_V2_ADDITIVE);

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

  it('re-installing an earlier version serves it — the installed version is the one every reader sees', async () => {
    // A revert: v1 is current again after v2. Left in place in the install history, v1's row was
    // installed while every reader still named v2 — a v1 op was answered stale until it gave up,
    // and the next cold start found no row at all. The `star-serves-current-ontology` scenario
    // drives the same revert through a real Apply; this pins the install half where CI runs it.
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    await installOntology(client, dev, 'v1', TODO_V1);
    await installOntology(client, dev, 'v2', TODO_V2_ADDITIVE);
    await installOntology(client, dev, 'v1', TODO_V1);

    const rid = crypto.randomUUID();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'after the revert', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client[Symbol.dispose]();
  });

  it('resetDevData wipes the sandbox and re-inits (M2)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    await installOntology(client, dev, 'v1', TODO_V1);

    const rid = crypto.randomUUID();
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

    // resetDevData wipes the ontology too; re-apply it as Flow 1b does (reset → install). The DO
    // survives: the resource is gone, and the rebuilt schema accepts a fresh read.
    await installOntology(client, dev, 'v1', TODO_V1);
    client.callStarRead(dev, 'v1', rid);
    expect(await waitForSuccess(client)).toBeNull();

    client[Symbol.dispose]();
  });

  it('resetDevData is admin-gated; a non-admin {u}.{g}.dev caller is rejected (B1)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client: admin } = await devAdminClient(galaxy, dev);
    await installOntology(admin, dev, 'v1', TODO_V1);

    // A non-admin member OF THE DEV STAR ITSELF — not of the galaxy above it. Passage is
    // computed from the caller's own `authScope`, so a galaxy-tier non-admin has no passage into a
    // Star beneath (ADR-015: upward only, without dominion) and would be refused by `onBeforeCall`
    // before `resetDevData`'s own guard ever ran — greening this test on the wrong refusal. Being
    // a member of the Star is what "a non-admin who can reach this Star" now means.
    const adminBrowser = new Browser();
    const { accessToken } = await foundAndLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
    await createSubject(adminBrowser, dev, accessToken, 'user@example.com');
    const { client: user } = await createInvitedClient(
      NebulaClientTest, new Browser(), dev, dev, 'user@example.com',
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
    const { client } = await universeAdminClient(
      NebulaClientTest, new Browser(), galaxy, starA, 'admin@example.com',
    );

    // Seed state the wipe owns — a committed Resource. (The Star's `config` would prove nothing:
    // the wipe erases only what the plane owns, so config survives a wipe that ran.)
    await installOntology(client, starA, 'v1', TODO_V1);
    const rid = crypto.randomUUID();
    client.callStarTransaction(starA, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'kept', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    // Admin caller (requireDominionHere passes) but the plane's wipe refuses off `.dev`. Capable-of-
    // failing: delete the check, and the Resource below is gone. This limb alone cannot tell WHERE
    // the check lives — a copy moved into `resetDevData` would refuse the same way — so the
    // install-path limbs in `plane-wipe.test.ts` (off `.dev`, on a Star and a Galaxy) are the other
    // half: a check that left the plane's wipe lets an install-triggered wipe through there.
    client.callStarResetDevData(starA);
    await waitForResult(client);
    expect(client.lastError).toMatch(/only permitted on the \.dev sandbox Star/);

    // Wipes nothing — the refusal comes before the wipe touches anything, so the Resource and the
    // installed version survive.
    client.callStarRead(starA, 'v1', rid);
    expect((await waitForSuccess(client) as Snapshot).value).toMatchObject({ title: 'kept' });

    client[Symbol.dispose]();
  });

  it('reset effect: pre-reset resource reads null and a pre-wipe node is absent (caches rebuilt); no FK orphans', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    await installOntology(client, dev, 'v1', TODO_V1);

    // A child node + a resource attached to it.
    client.callStarCreateNode(dev, ROOT_NODE_ID, 'child', 'Child');
    const childNodeId = await waitForSuccess(client) as string;
    const rid = crypto.randomUUID();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: childNodeId, value: { title: 'x', done: false } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client.callStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();

    // Re-apply the ontology after the wipe (Flow 1b: reset → install).
    await installOntology(client, dev, 'v1', TODO_V1);

    // (a) The resource is gone (read → null).
    client.callStarRead(dev, 'v1', rid);
    expect(await waitForSuccess(client)).toBeNull();

    // The pre-wipe node is absent — NodeNotFoundError is thrown by #requireNodeExists
    // BEFORE the admin bypass, so a stale OrgTree cache (node still present) would NOT
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
    await installOntology(admin, dev, 'v1', TODO_V1);

    // A member OF THE DEV STAR (see the note in the admin-gated test above): passage is computed
    // from the caller's own scope, so the reader has to belong to the Star it reads.
    const adminBrowser = new Browser();
    const { accessToken } = await foundAndLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
    await createSubject(adminBrowser, dev, accessToken, 'user@example.com');
    const { client: user, payload: userPayload } = await createInvitedClient(
      NebulaClientTest, new Browser(), dev, dev, 'user@example.com',
    );
    const userSub = userPayload.sub;

    // Admin creates a resource at ROOT and grants the non-admin `read` on ROOT.
    const rid = crypto.randomUUID();
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
    await installOntology(admin, dev, 'v1', TODO_V1);
    admin.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'y', done: false } },
    });
    expect((await waitForSuccess(admin) as TransactionResult).ok).toBe(true);

    // The non-admin read is now DENIED — grant wiped + permission cache rebuilt.
    // Reader must be non-admin: requirePermission short-circuits on access.scopeAdmin before
    // consulting the grant, so an admin reader would green vacuously.
    user.callStarRead(dev, 'v1', rid);
    await waitForResult(user);
    expect(user.lastError).toMatch(/permission required/i);

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  // A transaction suspended at the validator while `resetDevData` wipes answers stale and writes
  // nothing: `plane-wipe.test.ts` holds one there, on this path and the install's.

  it('breaking edit → reset loop: stale snapshot invalid under new version; reset; fresh write validates (M5)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    await installOntology(client, dev, 'v1', TODO_V1);
    const rid = crypto.randomUUID();
    client.callStarTransaction(dev, 'v1', {
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    expect(r1.ok).toBe(true);
    const eTag1 = r1.ok ? r1.eTags[rid] : '';

    // v2 — BREAKING: a required `priority`. Apply.
    await installOntology(client, dev, 'v2', TODO_V2_BREAKING);

    // The pre-edit snapshot is invalid under v2 — a put of its old shape (missing
    // required `priority`) fails validation.
    client.callStarTransaction(dev, 'v2', {
      [rid]: { op: 'put', eTag: eTag1, value: { title: 'a', done: false } },
    });
    const rBad = await waitForSuccess(client) as TransactionResult;
    expect(rBad.ok).toBe(false);
    if (!rBad.ok) expect(rBad.errors[rid].type).toBe('validation');

    // Reset → empty; re-apply v2 (Flow 1b: reset → install the new ontology).
    client.callStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();
    await installOntology(client, dev, 'v2', TODO_V2_BREAKING);

    // A fresh write satisfying v2 (includes `priority`) validates + commits.
    const rid2 = crypto.randomUUID();
    client.callStarTransaction(dev, 'v2', {
      [rid2]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'b', done: false, priority: 'high' } },
    });
    expect((await waitForSuccess(client) as TransactionResult).ok).toBe(true);

    client[Symbol.dispose]();
  });
});

describe('resetDevData capability surface (Star.prototype)', () => {
  it('resetDevData lives on base Star.prototype, mesh-callable + admin-gated', () => {
    const fn = (Star.prototype as unknown as Record<string, unknown>).resetDevData as (...a: unknown[]) => unknown;
    expect(typeof fn).toBe('function');
    expect(isMeshCallable(fn)).toBe(true);
    expect(getMeshGuard(fn)).toBe(requireDominionHere);
  });

  it('the Star\'s whole @mesh surface, by guard tier, equals the frozen allow-list', () => {
    // Every entry reachable on the Star's prototype chain, read as the entry rule looks for
    // `@mesh()`. `NebulaDO.teardown` carries `@rawRpc()` instead, so it is absent: restoring its
    // `@mesh()` reds this. A new entry, a dropped guard, or
    // `@mesh()` on the undecorated `resourcesResults` changes a list here. Installs arrive only by
    // lazy-pull from the Galaxy registry, landing at `resourcesResults.onOntologyPulled` behind that
    // undecorated gate; the eager push's remote `installOntology` / `setOntology` are gone.
    const tier = (guard: unknown) => (guard === requireDominionHere ? 'dominion' : guard === undefined ? 'bare' : 'other');
    const byTier: Record<string, string[]> = {};
    for (const { name, guard } of meshEntries(Star)) (byTier[tier(guard)] ??= []).push(name);
    expect(byTier).toEqual({
      bare: ['getStarConfig', 'resources'],
      dominion: ['resetDevData', 'setStarConfig'],
    });
  });
});
