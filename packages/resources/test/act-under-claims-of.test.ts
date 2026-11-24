/**
 * `Resources.actUnderClaimsOf`: a host runs a block under the claims recorded on one snapshot.
 *
 * vitest-plugin, because only a host's own code calls it, so no Client and no scenario can reach it
 * until a Galaxy's agent loop does: a probe on the test host is the only caller. Every record the
 * block acts under is real, though. Each resource is written by a `NebulaClient` logged in through
 * Mesh's Registry (ADR-009 rung 2), so the server stamped its record from a verified token, and
 * the probe is called on the stub, with no call running, so nothing the block reads can come from
 * the caller. `waiting-posts-answered` drives the same path through a Galaxy's chat.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import { PLATFORM } from '../../mesh/test/auth/test-helpers';
import { loginAt, uniqueScope, type Login } from '../../mesh/test/support/login';
import { ONTOLOGY_VERSION, GRANTED_NODE_ID, HOST_PRINCIPAL } from './test-worker';
import type { ResourcesHostDO, SelfBuildingHostDO } from './test-worker';

const PRINCIPAL = 'agent:test';

async function pageClient(login: Login): Promise<NebulaClient> {
  const browser = new Browser();
  browser.setCookie(login.cookie.name, login.cookie.value, { domain: new URL(PLATFORM).hostname, path: '/' });
  const page = browser.context(login.baseUrl);
  const client = new NebulaClient({
    instanceName: `${login.sub}.tab1`, baseUrl: login.baseUrl, platformOrigin: PLATFORM,
    ontologyVersion: ONTOLOGY_VERSION, fetch: page.fetch, WebSocket: page.WebSocket,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** A `Board` at the root, created by `client`; returns its id. */
async function boardBy(client: NebulaClient): Promise<string> {
  const id = crypto.randomUUID();
  const outcome = await client.resources.transaction({
    [id]: { op: 'create', typeName: 'Board', nodeId: ROOT_NODE_ID, value: { title: 'a request' } },
  });
  expect(outcome.kind).toBe('committed');
  return id;
}

const hostOf = (universe: string) => env.STAR.getByName(universe) as unknown as DurableObjectStub<ResourcesHostDO>;

describe('Resources.actUnderClaimsOf', { timeout: 60000 }, () => {
  // MUTATIONS: build the claims from the wire projection, and `access` and `aud` are missing;
  // build from the call the probe runs in, and there is none, so the block reads no claims.
  it('runs the block under the writer\'s full record, which no Client\'s read shows', async () => {
    const universe = uniqueScope('a');
    const admin = await loginAt(universe);
    using client = await pageClient(admin);
    const boardId = await boardBy(client);
    const host = hostOf(universe);
    const validFrom = (await host.currentValidFrom(boardId))!;

    const probed = await host.probeActUnder(boardId, validFrom, PRINCIPAL);
    expect(probed.ran).toBe(true);
    expect(probed.claims).toMatchObject({
      sub: admin.sub,
      aud: universe,
      access: { authScope: universe, scopeAdmin: true },
      act: { sub: PRINCIPAL, profileId: PRINCIPAL },
    });

    // What a Client reads of the same snapshot: who wrote it, and nothing of their authority.
    const read = await client.lmz.callAsync('STAR', universe, (client.ctn() as any).resources.read(ONTOLOGY_VERSION, boardId)) as
      { meta: { validFrom: string; recordedClaims: Record<string, unknown> } };
    expect(read.meta.validFrom).toBe(validFrom);
    expect(Object.keys(read.meta.recordedClaims).sort()).toEqual(['profileId', 'sub']);
  });

  // MUTATION: skip the comparison with the current `validFrom`, and the block runs under the
  // record of whoever wrote the resource last.
  it('throws before the block runs when the resource has been written again', async () => {
    const universe = uniqueScope('a');
    const admin = await loginAt(universe);
    using client = await pageClient(admin);
    const boardId = await boardBy(client);
    const host = hostOf(universe);
    const first = (await host.currentValidFrom(boardId))!;
    const put = await client.resources.transaction({
      [boardId]: { op: 'put', typeName: 'Board', ifValidFromMatches: first, value: { title: 'edited' } },
    });
    expect(put.kind).toBe('committed');
    const second = (await host.currentValidFrom(boardId))!;
    expect(second > first).toBe(true);

    const stale = await host.probeActUnder(boardId, first, PRINCIPAL);
    expect(stale.ran).toBe(false);
    expect(stale.error?.name).toBe('ResourceMovedOnError');
    // The positive control: the current snapshot's moment still runs.
    expect((await host.probeActUnder(boardId, second, PRINCIPAL)).ran).toBe(true);
  });

  // MUTATION: accept a tombstone's record, and the block runs for the person who deleted it.
  it('throws before the block runs when the resource has been deleted', async () => {
    const universe = uniqueScope('a');
    const admin = await loginAt(universe);
    using client = await pageClient(admin);
    const boardId = await boardBy(client);
    const host = hostOf(universe);
    const created = (await host.currentValidFrom(boardId))!;
    const gone = await client.resources.transaction({ [boardId]: { op: 'delete', typeName: 'Board', ifValidFromMatches: created } });
    expect(gone.kind).toBe('committed');
    const tombstone = (await host.currentValidFrom(boardId))!;

    for (const moment of [created, tombstone]) {
      const probed = await host.probeActUnder(boardId, moment, PRINCIPAL);
      expect(probed.ran).toBe(false);
      expect(probed.error?.name).toBe('ResourceMovedOnError');
    }
  });

  // An agent principal's own write is no one to act for: `lmz.actFor` refuses its record.
  it('throws before the block runs on a resource the host\'s agent principal wrote', async () => {
    const name = `built-${crypto.randomUUID().slice(0, 8)}`;
    const host = env.SELF_BUILDING.getByName(name) as unknown as DurableObjectStub<SelfBuildingHostDO>;
    await host.initForTest(name);
    const id = crypto.randomUUID();
    expect((await host.createAsPrincipal(id, GRANTED_NODE_ID)).ok).toBe(true);
    expect(await host.recordedSubject(id)).toBe(HOST_PRINCIPAL);

    const probed = await host.probeActUnder(id, (await host.currentValidFrom(id))!, PRINCIPAL);
    expect(probed.ran).toBe(false);
    expect(probed.error?.message).toMatch(/not shaped like a person's id/);
  });

  // A grant in the tree is read when the write arrives, so one taken away since the record was
  // stamped refuses the write. The writer is a plain member: an admin's bit would bypass the grant.
  // MUTATION: skip the orgTree check for a write made under a record, and the second write lands.
  it('refuses a write under a record whose writer has lost the grant since', async () => {
    const universe = uniqueScope('a');
    const admin = await loginAt(universe);
    const member = await loginAt(universe);
    expect(member.admin).toBe(false);
    using adminClient = await pageClient(admin);
    using memberClient = await pageClient(member);
    const tree = (adminClient.ctn() as any).resources.orgTree;
    await adminClient.lmz.callAsync('STAR', universe, tree.setPermission(ROOT_NODE_ID, member.sub, 'write'));

    const boardId = await boardBy(memberClient);
    const host = hostOf(universe);
    const validFrom = (await host.currentValidFrom(boardId))!;

    // The positive control: while the grant stands, a write under the record lands.
    expect((await host.createUnder(boardId, validFrom, PRINCIPAL, crypto.randomUUID(), ROOT_NODE_ID)).ok).toBe(true);

    await adminClient.lmz.callAsync('STAR', universe, tree.revokePermission(ROOT_NODE_ID, member.sub));
    const refusedId = crypto.randomUUID();
    expect(await host.createUnder(boardId, validFrom, PRINCIPAL, refusedId, ROOT_NODE_ID)).toEqual({
      ok: false,
      errors: { [refusedId]: { type: 'permission', requiredTier: 'write', nodeId: ROOT_NODE_ID } },
    });
  });

  // A chain over the wire cannot test this: the fourth argument is a function, and no chain
  // carrying one arrives, so it would be refused whether or not the member were there.
  // MUTATION: add `actUnderClaimsOf` to the `requests` surface.
  it('is not on the surface a host hands the wire', async () => {
    const universe = uniqueScope('a');
    await loginAt(universe);
    const host = hostOf(universe);
    expect(await host.requestsHas('actUnderClaimsOf')).toBe(false);
    expect(await host.requestsHas('transaction')).toBe(true);
  });
});
