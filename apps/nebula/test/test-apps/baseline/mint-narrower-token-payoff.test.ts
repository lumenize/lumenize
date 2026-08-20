/**
 * `/mint-narrower-token` — **the payoff**, asserted as a DAG VERDICT rather than a claim.
 *
 * Every other criterion for this endpoint reads claims off the mint response. This one asserts what
 * the feature is actually *for*: mirroring the subject's `admin` bit puts `resolvePermission` back in
 * the decision, so an admin can observe the denial they came to debug. With the caller's bit instead,
 * `dag-tree.ts`'s scope-admin bypass fires and the denial never happens — the token wears the
 * subject's name while acting with admin-derived authority they do not have.
 *
 * **Vehicle: `admin.impersonate(subjectSub, scope)`** — the production client capability, driven
 * through the REAL `NebulaClientGateway`. It mints through the same `/mint-narrower-token` endpoint
 * and hands the result to a full `NebulaClient`, so this exercises the path the Studio actually
 * takes rather than a hand-rolled `LumenizeClient` no product code can reach.
 *
 * ADR-009 **rung 2**, like the whole `baseline` lane: real founding, real invite, real
 * server-issued login (test-mode issuance — the magic link is read from the response, gated by the
 * `NEBULA_AUTH_TEST_MODE` binding), and the token under test comes from the production endpoint.
 * The earlier "rung 1" label here was wrong: rung 1 is the real email transport, which this lane
 * does not use.
 *
 * @see tasks/archive/nebula-impersonation-client.md Phase 4
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { env, runInDurableObject } from 'cloudflare:test';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Star, TransactionResult, Snapshot } from '@lumenize/nebula';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import { universeAdminClient, createInvitedClient, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = 'interface Note { label: string }';

describe('/mint-narrower-token — the DAG verdict', () => {
  it('a narrower token for a NON-admin member is DENIED a write the caller is allowed', async () => {
    const universe = `mnt-${crypto.randomUUID().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();

    // Caller: a `{u}` universe admin — administers the whole star, so eligible for the mint.
    const { client: admin, accessToken: adminToken, payload: adminPayload } = await universeAdminClient(
      NebulaClientTest, browser, star, star, 'admin@example.com',
    );
    admin.callStarApplyOntology(star, { version: VERSION, types: TYPES });
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

    // A private node — the member holds no grant anywhere on it.
    admin.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Priv');
    await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
    const priv = admin.lastResult as string;

    // Subject: a real invited NON-admin member of the star.
    await createSubject(browser, star, adminToken, 'member@example.com');
    const { client: memberClient, payload: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'member@example.com',
    );
    expect(member.access.scopeAdmin).toBeUndefined(); // fixture guard: the subject really is non-admin

    // The mint, through the production endpoint — via the production client capability.
    using impersonating = await admin.impersonate(member.sub, star);
    await vi.waitFor(() => expect(impersonating.connectionState).toBe('connected'));
    expect(impersonating.claims.sub).toBe(member.sub);
    expect(impersonating.claims.act?.sub).toBe(adminPayload.sub);
    // The mirror: the subject is non-admin, so the token carries NO admin bit. This is the operand
    // the assertion below actually turns on.
    expect(impersonating.claims.access.scopeAdmin).toBeUndefined();

    // ── The verdict ──────────────────────────────────────────────────────────────────────────────
    const denied = await impersonating.lmz.callAsync('STAR', star,
      impersonating.ctn<Star>().transaction(VERSION, crypto.randomUUID(), {
        [crypto.randomUUID()]: { op: 'create', typeName: 'Note', nodeId: priv, value: { label: 'nope' } },
      })) as TransactionResult;
    expect(denied.ok).toBe(false);
    expect(Object.values((denied as { ok: false; errors: Record<string, any> }).errors)[0].type)
      .toBe('permission');

    // Control: the SAME write with the caller's OWN token commits — so the path is reachable and the
    // denial above is the `admin` mirror, not a plumbing failure.
    admin.callStarTransaction(star, VERSION, {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Note', nodeId: priv, value: { label: 'yes' } },
    });
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
    expect((admin.lastResult as TransactionResult).ok).toBe(true);

    admin[Symbol.dispose](); memberClient[Symbol.dispose]();
  });

  // ── `actingToken` is the FULL ADR-016 record — and "same actor" derives from IDENTITY alone ─────
  // The persisted column stores the whole projected claims: subject `sub` + `profileId`, the widened
  // `act` chain (the actor PAIR, actor `profileId` included), and the asserted `access`. The coalesce
  // key is deliberately NOT the record — it is `sub` + the chain's `sub`s, so a claims delta a
  // re-mint can produce mid-window cannot split an editing session's rows.
  //
  // **Principal, pinned:** the subject is granted an explicit `write` tier on the node FIRST. Without
  // it a narrower token for a non-admin subject holds no DAG grant in a fresh Star and the write is
  // denied for an unrelated reason (the very denial the test above asserts).
  it('persists actingToken = the FULL claims record, coalesces same-identity writes, and SPLITS on a changed act chain', async () => {
    const universe = `mnt-${crypto.randomUUID().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();

    const { client: admin, accessToken: adminToken, payload: adminPayload } = await universeAdminClient(
      NebulaClientTest, browser, star, star, 'admin@example.com',
    );
    admin.callStarApplyOntology(star, { version: VERSION, types: TYPES });
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
    admin.callStarCreateNode(star, ROOT_NODE_ID, 'shared', 'Shared');
    await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
    const node = admin.lastResult as string;

    await createSubject(browser, star, adminToken, 'writer@example.com');
    const { client: memberClient, payload: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'writer@example.com',
    );
    admin.callStarSetPermission(star, node, member.sub, 'write');
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

    using impersonating = await admin.impersonate(member.sub, star);
    await vi.waitFor(() => expect(impersonating.connectionState).toBe('connected'));
    // Fixture guard first: an ABSENT admin profileId would make the actor-profileId operand below
    // vacuous (toEqual treats `profileId: undefined` as a missing key).
    expect(adminPayload.profileId).toBeDefined();
    expect(impersonating.claims.act?.profileId).toBe(adminPayload.profileId); // the claim DOES carry it

    const rid = crypto.randomUUID();
    const commit = (label: string) => impersonating.lmz.callAsync('STAR', star,
      impersonating.ctn<Star>().transaction(VERSION, crypto.randomUUID(),
        { [rid]: { op: 'create', typeName: 'Note', nodeId: node, value: { label } } }));
    const first = await commit('one') as TransactionResult;
    expect(first.ok).toBe(true);

    // Assert the PERSISTED column — the mechanism the invariant governs, not a value echoed into a
    // payload. Mutation: build the record with an identity-only/narrowed projection instead of the
    // shared `projectActingToken` → `profileId`/actor-`profileId`/`access` vanish → this reds.
    const rows = () => (runInDurableObject as any)(
      (env as any).STAR.getByName(star),
      (inst: any) => [...inst.ctx.storage.sql.exec(
        'SELECT actingToken, validFrom FROM Snapshots WHERE resourceId = ?', rid)]
        .map((r: any) => ({ actingToken: r.actingToken as string, validFrom: r.validFrom as string })),
    );
    const after1 = await rows();
    expect(after1).toHaveLength(1);
    expect(JSON.parse(after1[0].actingToken)).toEqual({
      sub: member.sub,
      act: { sub: adminPayload.sub, profileId: adminPayload.profileId },
      profileId: member.profileId,
      access: { authScope: star },
    });

    // The WIRE copy carries the chain for display — actor `sub` + actor `profileId` ride; the
    // asserted `access` does not. Direct coverage of act-chain INCLUSION on the wire (not only via
    // the coalesce compare). Mutation: drop `act` from `toWireActingToken` → this reds.
    const wire = await impersonating.lmz.callAsync('STAR', star,
      impersonating.ctn<Star>().read(VERSION, rid)) as Snapshot;
    expect(wire.meta.actingToken.act).toEqual({ sub: adminPayload.sub, profileId: adminPayload.profileId });
    expect('access' in wire.meta.actingToken).toBe(false);

    // ...two same-actor writes inside the window still coalesce to ONE row...
    const second = await impersonating.lmz.callAsync('STAR', star,
      impersonating.ctn<Star>().transaction(VERSION, crypto.randomUUID(),
        { [rid]: { op: 'put', eTag: (first as { ok: true; eTags: Record<string, string> }).eTags[rid], value: { label: 'two' } } })) as TransactionResult;
    expect(second.ok).toBe(true);
    expect(await rows()).toHaveLength(1);

    // ...and a DIFFERENT act chain within the window SPLITS: the member's OWN write is the same
    // `sub` with no chain, so it must land a NEW row. Mutation: derive the identity key from `sub`
    // alone (ignore the chain) → this stays at 1 row → reds.
    memberClient.callStarTransaction(star, VERSION, {
      [rid]: { op: 'put', eTag: (second as { ok: true; eTags: Record<string, string> }).eTags[rid], value: { label: 'three' } },
    });
    await vi.waitFor(() => expect(memberClient.callCompleted).toBe(true));
    expect((memberClient.lastResult as TransactionResult).ok).toBe(true);
    expect(await rows()).toHaveLength(2);

    admin[Symbol.dispose](); memberClient[Symbol.dispose]();
  });

  // ── Same IDENTITY, different CLAIMS → still ONE row ─────────────────────────────────────────────
  // ADR-009 rung 3, justified in place: the TWO deltas this fixture varies are unreachable through
  // real issuance — a person's `profileId` never changes, and `access.authScope` is pinned to the
  // membership. (A same-sub `access` delta is not impossible in general — `setIdentityAdmin` flips
  // `scopeAdmin` under a fixed `sub` — but not these two, and they are what the identity-only key
  // exists to absorb: a future `sub`-unification re-points `profileId`; a broader re-login changes
  // `authScope`.) So the dangerous shape is hand-minted: two tokens sharing one `sub` with different
  // `profileId` AND different `access.authScope`. Both carry dominion over the star, so DAG
  // permission is not the variable.
  it('a claims delta under the SAME identity still coalesces — profileId and access stay out of the key', async () => {
    const universe = `mnt-${crypto.randomUUID().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const sub = crypto.randomUUID();

    const clientAt = async (instanceName: string, profileId: string) => {
      const browser = new Browser();
      const ctx = browser.context('http://localhost');
      const client = new NebulaClientTest({
        baseUrl: 'http://localhost', authScope: instanceName, activeScope: star, appVersion: 'v1',
        resourceHostBinding: 'STAR',
        accessToken: (await createNebulaTestToken({
          privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
          activeScope: star, instanceName, scopeAdmin: true, profileId, sub, ttlSeconds: 3600,
        })()).access_token,
        instanceName: `${sub}.${crypto.randomUUID().slice(0, 8)}`,
        fetch: browser.fetch, WebSocket: browser.WebSocket,
        sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      });
      await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
      return client;
    };

    // A: star-scoped admin, profileId P1. B: SAME sub, universe-scoped admin, profileId P2.
    const a = await clientAt(star, crypto.randomUUID());
    const b = await clientAt(universe, crypto.randomUUID());

    a.callStarApplyOntology(star, { version: VERSION, types: TYPES });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));

    const rid = crypto.randomUUID();
    a.callStarTransaction(star, VERSION, {
      [rid]: { op: 'create', typeName: 'Note', nodeId: ROOT_NODE_ID, value: { label: 'one' } },
    });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));
    const created = a.lastResult as TransactionResult;
    expect(created.ok).toBe(true);

    b.callStarTransaction(star, VERSION, {
      [rid]: { op: 'put', eTag: (created as { ok: true; eTags: Record<string, string> }).eTags[rid], value: { label: 'two' } },
    });
    await vi.waitFor(() => expect(b.callCompleted).toBe(true));
    expect((b.lastResult as TransactionResult).ok).toBe(true);

    // One row: the key is [sub] for both writes. Mutation: include `profileId` OR `access` in the
    // identity key (or key on the stringified record) → the deltas split this into 2 rows → reds.
    const count = await (runInDurableObject as any)(
      (env as any).STAR.getByName(star),
      (inst: any) => [...inst.ctx.storage.sql.exec(
        'SELECT COUNT(*) AS n FROM Snapshots WHERE resourceId = ?', rid)][0].n as number,
    );
    expect(count).toBe(1);

    a[Symbol.dispose](); b[Symbol.dispose]();
  });
});
