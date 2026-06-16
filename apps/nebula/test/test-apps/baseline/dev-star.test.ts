/**
 * Dev Star — P1: `DevStar` / `DEV_STAR` skeleton + addressing.
 *
 * Proves the dev Star is its own DO class + binding, reachable at `{u}.{g}.dev`
 * through the client's slug-derived binding selection, inheriting all Star
 * machinery (incl. the Fix-1 structural `onBeforeCall` and the Galaxy-admin
 * access bypass).
 *
 * @see tasks/dev-star.md § P1
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult, TransactionOutcome } from '@lumenize/nebula';
import {
  createAuthenticatedClient,
  browserLogin,
  createSubject,
  uniqueGalaxyScope,
  uniqueStar,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

const TODO = `interface Todo { title: string; done: boolean; }`;

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

/** A galaxy-admin client whose **active scope is the dev Star** (`{u}.{g}.dev`).
 *  authScope = galaxy (so the first login is the galaxy founder = admin); the
 *  refresh mints aud = `{u}.{g}.dev` with `access.admin: true`. */
async function devAdminClient(galaxy: string, dev: string) {
  const browser = new Browser();
  return createAuthenticatedClient(NebulaClientTest, browser, galaxy, dev, 'admin@example.com');
}

describe('Dev Star P1 — addressing & inheritance', () => {
  it('a DEV_STAR DO→DO call reaches the instance and accepts the matching {u}.{g}.dev aud', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    // `lmz.call('DEV_STAR', '{u}.{g}.dev', whoAmI())` — the literal-binding
    // DO→DO route. Reaching the instance + a non-error reply proves both
    // addressing and that the inherited onBeforeCall accepts the matching aud.
    client.callDevStarWhoAmI(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();
    expect(client.lastResult).toContain('You are');

    client[Symbol.dispose]();
  });

  it('DevStar onBeforeCall rejects a foreign aud (inherited Fix-1 structural check)', async () => {
    const { dev } = uniqueGalaxyScope();
    // A client authenticated at its OWN unrelated star scope addresses the
    // victim's dev Star. The bare 3-tuple `{u}.{g}.dev` → exact pattern →
    // matchAccess rejects the foreign aud, exactly like any Star.
    const foreign = uniqueStar();
    const browser = new Browser();
    const { client } = await createAuthenticatedClient(
      NebulaClientTest, browser, foreign, foreign, 'evil@example.com',
    );

    client.callDevStarWhoAmI(dev);
    await waitForResult(client);
    expect(client.lastError).toContain('Active-scope mismatch');
    expect(client.lastResult).toBeUndefined();

    client[Symbol.dispose]();
  });

  it('a {u}.{g}.dev client routes resource ops to DEV_STAR, not STAR (binding selection)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    // Ontology lives on the shared Galaxy ({u}.{g}); DEV_STAR's #galaxyId fetches it.
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO });
    await waitForSuccess(client);

    // PUBLIC API write — `#starBinding()` selects DEV_STAR for a `.dev` activeScope.
    const rid = generateUuid();
    const outcome = await client.resources.transaction({
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'in dev', done: false } },
    }) as TransactionOutcome;
    expect(outcome.kind).toBe('committed');

    // Capable-of-failing by RESOURCE IDENTITY (not whoAmI): the SAME instance
    // name on the STAR binding is a DIFFERENT DO with separate SQLite, so the
    // resource is absent there. If #starBinding wrongly returned 'STAR', the
    // write would have landed in STAR and these two assertions would invert.
    client.callStarRead(dev, 'v1', rid);
    expect(await waitForSuccess(client)).toBeNull();

    client.callDevStarRead(dev, 'v1', rid);
    const snap = await waitForSuccess(client) as Snapshot;
    expect(snap).not.toBeNull();
    expect((snap.value as { title: string }).title).toBe('in dev');

    client[Symbol.dispose]();
  });

  it('a galaxy admin reads/writes the dev Star via the access bypass; a non-admin is denied', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client: admin } = await devAdminClient(galaxy, dev);

    admin.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO });
    await waitForSuccess(admin);

    // Admin write — the `claims.access.admin` bypass clears requirePermission.
    const ridAdmin = generateUuid();
    admin.callDevStarTransaction(dev, 'v1', {
      [ridAdmin]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    const ar = await waitForSuccess(admin) as TransactionResult;
    expect(ar.ok).toBe(true);

    // A non-admin galaxy member (invited subject — NOT the founder) refreshed to
    // the dev activeScope: valid aud (onBeforeCall passes) but NO admin claim and
    // no DAG grant → the resource op is denied. Capable-of-failing: this is the
    // "remove the admin claim → access denied" control for the bypass above.
    const adminBrowser = new Browser();
    const { accessToken } = await browserLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
    await createSubject(adminBrowser, galaxy, accessToken, 'user@example.com');
    const userBrowser = new Browser();
    const { client: user } = await createAuthenticatedClient(
      NebulaClientTest, userBrowser, galaxy, dev, 'user@example.com',
    );

    const ridUser = generateUuid();
    user.callDevStarTransaction(dev, 'v1', {
      [ridUser]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'b', done: false } },
    });
    const ur = await waitForSuccess(user) as TransactionResult;
    expect(ur.ok).toBe(false);
    if (!ur.ok) expect(ur.errors[ridUser].type).toBe('permission');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });
});
