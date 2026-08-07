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
import { ROOT_NODE_ID, projectActClaim } from '@lumenize/nebula';
import type { Star, TransactionResult } from '@lumenize/nebula';
import { universeAdminClient, createInvitedClient, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = 'interface Note { label: string }';

describe('/mint-narrower-token — the DAG verdict', () => {
  it('a narrower token for a NON-admin member is DENIED a write the caller is allowed', async () => {
    const universe = `mnt-${crypto.randomUUID().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();

    // Caller: a `{u}.*` universe admin — administers the whole star, so eligible for the mint.
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

  // ── `changedBy` is unchanged in SHAPE ───────────────────────────────────────────────────────────
  // The widened `act` claim (now an actor PAIR) must not reach the persisted `Snapshots.changedBy`
  // column: it is typed as `@lumenize/crypto`'s NARROW `ActClaim` (which cannot declare `profileId` —
  // ADR-001) and its `JSON.stringify` IS the same-actor coalesce key.
  //
  // **Principal, pinned:** the subject is granted an explicit `write` tier on the node FIRST. Without
  // it a narrower token for a non-admin subject holds no DAG grant in a fresh Star and the write is
  // denied for an unrelated reason (the very denial the test above asserts).
  it('persists changedBy = { sub, act: { sub } } with NO profileId, and still coalesces', async () => {
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
    expect(impersonating.claims.act?.profileId).toBe(adminPayload.profileId); // the claim DOES carry it

    const rid = crypto.randomUUID();
    const commit = (label: string) => impersonating.lmz.callAsync('STAR', star,
      impersonating.ctn<Star>().transaction(VERSION, crypto.randomUUID(),
        { [rid]: { op: 'create', typeName: 'Note', nodeId: node, value: { label } } }));
    const first = await commit('one') as TransactionResult;
    expect(first.ok).toBe(true);

    // Assert the PERSISTED column — its `JSON.stringify` is the coalesce key, so this is the
    // mechanism the invariant governs, not a value echoed into a payload.
    const rows = () => (runInDurableObject as any)(
      (env as any).STAR.getByName(star),
      (inst: any) => [...inst.ctx.storage.sql.exec(
        'SELECT changedBy, validFrom FROM Snapshots WHERE resourceId = ?', rid)]
        .map((r: any) => ({ changedBy: r.changedBy as string, validFrom: r.validFrom as string })),
    );
    const after1 = await rows();
    expect(after1).toHaveLength(1);
    // Mutation: spread the raw `payload.act` → `act` carries `profileId` → this reds.
    expect(JSON.parse(after1[0].changedBy)).toEqual({ sub: member.sub, act: { sub: adminPayload.sub } });

    // ...and two same-actor writes inside the window still coalesce to ONE row.
    const second = await impersonating.lmz.callAsync('STAR', star,
      impersonating.ctn<Star>().transaction(VERSION, crypto.randomUUID(),
        { [rid]: { op: 'put', eTag: (first as { ok: true; eTags: Record<string, string> }).eTags[rid], value: { label: 'two' } } })) as TransactionResult;
    expect(second.ok).toBe(true);
    expect(await rows()).toHaveLength(1);

    admin[Symbol.dispose](); memberClient[Symbol.dispose]();
  });
});

// ── The recursive projection, at a depth NO MINT CAN PRODUCE ──────────────────────────────────────
// `/mint-narrower-token`'s root-identity gate caps its own output at depth 1 and its builder writes a
// flat actor, so no end-to-end fixture can distinguish a one-level projection from a recursive one —
// which is exactly why this is a unit test on a hand-built chain. `#buildChangedBy` cannot be the
// vehicle: it is `#`-private AND zero-parameter (it reads `callContext`), so nothing can hand it a
// payload, and `coding-style.md` forbids downgrading `#` to TS `private` to make it testable.
describe('projectActClaim', () => {
  it('drops profileId at EVERY depth, preserving the chain', () => {
    const chain = {
      sub: 'a', profileId: 'pa',
      act: { sub: 'b', profileId: 'pb', act: { sub: 'c', profileId: 'pc' } },
    };
    // Mutation: replace the recursive call with `{ sub: a.sub, ...(a.act && { act: a.act }) }` →
    // depths 2 and 3 keep their `profileId` → this reds. (Nothing else in the repo can red it.)
    expect(projectActClaim(chain)).toEqual({ sub: 'a', act: { sub: 'b', act: { sub: 'c' } } });
  });
});
