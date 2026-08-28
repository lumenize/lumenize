/**
 * Phase 2 of tasks/nebula-confine-admin-bypass.md — the DAG permission plane is confined to the
 * host it runs on. TWO confinement points:
 *   1. `DagTree.requirePermission` — the LIVE claim.
 *   2. `Subscriptions` / `QuerySubs` subscribe-time writers — the STORED verdict (the push path
 *      never re-reads the JWT, so confining only the live claim leaves that back door open).
 * `evaluatePermissions` is NOT a third point — it takes no pattern and no host name; it consumes
 * whatever the store wrote. The loop is closed here by feeding the persisted bit into it.
 *
 * ⚠️ WHY A SYNTHETIC HOST. Every DagTree host that exists today (Star `{u}.{g}.{s}`, DevStudio
 * `{u}.{g}.dev`) is a **star-tier leaf**, whose admin's `authScope` IS that exact id, so
 * admission already implies the confined predicate and the escalation CANNOT occur. Written against
 * a real host these assertions would be vacuously green — the exact trap this task exists to
 * eliminate. So we construct `DagTree` directly on a **non-leaf** host name (`{u}.{g}`), which is
 * what nebula-galaxy-collapse-and-chat.md lands for real.
 *
 * ⚠️ HOSTED IN A `Galaxy` DO — deliberately, because Galaxy builds NO `ResourceDataPlane`. A
 * co-resident host instance would own its own `DagTree` with its own cache; `DagTree` caches per
 * instance and `#invalidate()`s only on its own mutations, so a grant written through the host's
 * instance is invisible to the fixture's. Worse than a false red: `#requireNodeExists` runs first,
 * so a stale-cache miss throws `NodeNotFoundError` and a `toThrow` deny assertion would pass for
 * the WRONG reason.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { DagTree, Subscriptions, QuerySubs, Resources, ROOT_NODE_ID, CHAT_NODE_ID, DEFAULT_CHAT_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import type { CallContext } from '@lumenize/mesh';
import { Browser } from '@lumenize/testing';
import { universeAdminClient, foundAndLogin, createSubject, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const CHAT_QUERY = {
  queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID,
};

const uniqueGalaxy = () => `cdp-${crypto.randomUUID().slice(0, 8)}.app`;

/** A synthetic CallContext carrying exactly the claim shape under test. */
function ctxFor(sub: string, access?: { admin?: boolean; authScope?: string }): CallContext {
  return { callChain: [], state: {}, originAuth: { sub, claims: { aud: 'ignored', access } } } as any;
}

/**
 * Build a `DagTree` (+ optionally the two subscribe-time writers) on a real `ctx` inside a Galaxy
 * DO, with a NON-LEAF host name. `claims` is mutable so one fixture can re-issue calls as different
 * principals without rebuilding the tree — every write goes through THIS instance, so the cache
 * stays coherent (see the header warning).
 */
async function onNonLeafHost<T>(
  hostName: string,
  body: (h: {
    tree: DagTree;
    subs: Subscriptions;
    querySubs: QuerySubs;
    as: (sub: string, access?: { admin?: boolean; authScope?: string }) => void;
  }) => T | Promise<T>,
): Promise<T> {
  const stub = (env as any).GALAXY.getByName(hostName);
  return (runInDurableObject as any)(stub, async (inst: any) => {
    let cc = ctxFor('nobody');
    const getCallContext = () => cc;
    const getHostName = () => hostName;
    const tree = new DagTree(inst.ctx, getCallContext, () => {}, getHostName);
    const resources = new Resources(inst.ctx, getCallContext, tree);
    const subs = new Subscriptions(inst.ctx, getCallContext, tree, resources, getHostName);
    const querySubs = new QuerySubs(inst.ctx, getCallContext, tree, resources, getHostName);
    const as = (sub: string, access?: { admin?: boolean; authScope?: string }) => {
      cc = ctxFor(sub, access);
    };
    return body({ tree, subs, querySubs, as });
  });
}

// The two principals the whole task turns on. Both are `admin: true`.
const COVERING = (g: string) => ({ scopeAdmin: true, authScope: `${g}` });   // reaches this host
const DESCENDANT = (g: string) => ({ scopeAdmin: true, authScope: `${g}.dev` }); // exact-star, does NOT

describe('Phase 2 — the DAG permission plane is confined to its host', () => {
  describe('confinement point 1: requirePermission (live claim)', () => {
    it('a descendant-scope admin with NO DAG grant is DENIED on a non-leaf host', async () => {
      const g = uniqueGalaxy();
      await onNonLeafHost(g, ({ tree, as }) => {
        as('descendant-admin', DESCENDANT(g));
        // Pre-fix the bare `access.scopeAdmin` bit short-circuited before any DAG lookup and this
        // returned the sub. `{g}.dev` does not cover `{g}`, so the bypass must not apply.
        expect(() => tree.requirePermission(ROOT_NODE_ID, 'admin')).toThrow();
      });
    });

    it('a COVERING admin with no DAG grant still passes (the confinement is not over-tight)', async () => {
      const g = uniqueGalaxy();
      await onNonLeafHost(g, ({ tree, as }) => {
        as('covering-admin', COVERING(g));
        expect(tree.requirePermission(ROOT_NODE_ID, 'admin')).toBe('covering-admin');
      });
    });

    it('a NON-admin is byte-identical to before — denied without a grant, allowed with one', async () => {
      const g = uniqueGalaxy();
      await onNonLeafHost(g, ({ tree, as }) => {
        as('plain-user'); // no access claim at all — never entered the admin branch, pre or post
        expect(() => tree.requirePermission(ROOT_NODE_ID, 'read')).toThrow();
        as('covering-admin', COVERING(g));
        tree.setPermission(ROOT_NODE_ID, 'plain-user', 'read');
        as('plain-user');
        expect(tree.requirePermission(ROOT_NODE_ID, 'read')).toBe('plain-user');
      });
    });
  });

  describe('confinement point 2: the stored verdict (split by table — different admission paths)', () => {
    // `registerQuerySubscriber` runs NO permission check at registration (authorize at delivery,
    // D2/D4), so the row is written for any caller and the stored bit is directly observable.
    it('QuerySubs stores 0 for a descendant-scope admin and 1 for a covering one', async () => {
      const g = uniqueGalaxy();
      const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: 'p1' };
      const { descendant, covering } = await onNonLeafHost(g, ({ querySubs, as }) => {
        as('descendant-admin', DESCENDANT(g));
        const d = querySubs.registerQuerySubscriber(query, 'client-d', 'BINDING');
        as('covering-admin', COVERING(g));
        const c = querySubs.registerQuerySubscriber(query, 'client-c', 'BINDING');
        return { descendant: d.row.dominionOverHostAtSubscribe, covering: c.row.dominionOverHostAtSubscribe };
      });
      // Pre-fix BOTH were 1 (the raw bit). The stored value is a verdict, not a claim.
      expect(descendant).toBe(0);
      expect(covering).toBe(1);
    });

    // The `Subscriptions` half — the deferred store-side assertion — now runs for REAL in
    // the integration block at the bottom of this file: the Galaxy chat plane is the
    // non-leaf host with an ontology this fixture could not stand up, so the granted
    // `.dev` admin's stored bit is asserted on the actual `Subscribers` table there.
  });

  describe('closing the loop on the consumer (evaluatePermissions)', () => {
    // `evaluatePermissions` consumes the STORED bit. Feeding the persisted value in is what makes
    // the store-side confinement observable end-to-end; asserting on this method standalone would
    // be vacuous, since it never sees a pattern.
    it('the persisted verdict drives evaluatePermissions: descendant denied, covering allowed', async () => {
      const g = uniqueGalaxy();
      const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: 'p1' };
      const { dAllowed, cAllowed } = await onNonLeafHost(g, ({ tree, querySubs, as }) => {
        as('descendant-admin', DESCENDANT(g));
        const d = querySubs.registerQuerySubscriber(query, 'client-d', 'BINDING');
        as('covering-admin', COVERING(g));
        const c = querySubs.registerQuerySubscriber(query, 'client-c', 'BINDING');
        // Neither holds a DAG grant, so ONLY the stored verdict can allow them.
        const dEval = tree.evaluatePermissions([ROOT_NODE_ID], 'read', 'descendant-admin', Boolean(d.row.dominionOverHostAtSubscribe));
        const cEval = tree.evaluatePermissions([ROOT_NODE_ID], 'read', 'covering-admin', Boolean(c.row.dominionOverHostAtSubscribe));
        return { dAllowed: dEval.allowed.has(ROOT_NODE_ID), cAllowed: cEval.allowed.has(ROOT_NODE_ID) };
      });
      // Reverting the store-side confinement makes dAllowed true → this reds.
      expect(dAllowed).toBe(false);
      expect(cAllowed).toBe(true);
    });
  });

  // ─── The REAL non-leaf host — the Galaxy chat plane (integration) ─────────────
  //
  // The synthetic fixture above proves the predicates in isolation; these two run the
  // same escalation against the SHIPPED host: the collapsed Galaxy's chat data plane at
  // `{u}.{g}`, with its platform ontology installed and real invited identities. The
  // dangerous principal is the invite's own co-mint — a galaxy-tier invite mints the
  // `.dev` membership WITH `scopeAdmin` — so the fixture's admin bit comes from the
  // production mint path, not a hand-built claim.
  describe('the real non-leaf host — the Galaxy chat plane', () => {
    it('a {u}.{g}.dev-scoped ADMIN with no DAG grant is DENIED on the chat node; a grant opens exactly that door', async () => {
      const scope = `cab-${crypto.randomUUID().slice(0, 8)}.app`;
      const { client: admin, accessToken } = await universeAdminClient(
        NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
        { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
      );
      // Seed real content at the chat node (two model rounds: the seed turn + the
      // granted post's turn below), so the denial withholds something that exists.
      admin.callGalaxySeedChatScript(scope, [
        { choices: [{ message: { content: 'seeded', reasoning_content: '', tool_calls: [] } }] },
        { choices: [{ message: { content: 'granted reply', reasoning_content: '', tool_calls: [] } }] },
      ], {});
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
      using adminSub = admin.resources.subscribeQuery(CHAT_QUERY); await adminSub.ready;
      await admin.postUserMessage('seed the thread');
      await vi.waitFor(() => expect(adminSub.resourceIds.length).toBeGreaterThanOrEqual(2), { timeout: 15000 });

      // The escalation principal, via the REAL mint: invite at the galaxy → the co-minted
      // `{scope}.dev` membership carries scopeAdmin — then log in AT that `.dev` scope.
      const adminBrowser = new Browser();
      await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
      await createSubject(adminBrowser, scope, accessToken, 'devadmin@example.com');
      const { client: devAdmin, payload } = await createInvitedClient(
        NebulaClientTest, new Browser(), `${scope}.dev`, `${scope}.dev`, 'devadmin@example.com',
        CHAT_MESSAGE_ONTOLOGY_VERSION,
        { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
      );
      // The fixture guard: the claim must BE the dangerous shape — the bare bit set, the
      // scope strictly below the host — or the denial below cannot fail for the right reason.
      expect(payload.access.scopeAdmin).toBe(true);
      expect(payload.access.authScope).toBe(`${scope}.dev`);

      // THE DOOR: pre-confinement the bare `scopeAdmin` bit short-circuited the DAG and
      // this post would have LANDED (`{scope}.dev` does not cover `{scope}`). Match the
      // MESSAGE — a boundary refusal and a DAG refusal are indistinguishable as booleans,
      // and the /permission/i match is itself proof the call passed the boundary (passage
      // admits the `.dev` caller upward as a tenant; disclosure is T4's, in chat-trigger).
      await expect(devAdmin.postUserMessage('as the dev admin')).rejects.toThrow(/permission/i);

      // POSITIVE CONTROL: a covering admin grants write at the chat node → the SAME
      // caller's SAME op lands — the refusal above was the DAG's and nothing else's.
      await admin.lmz.callAsync('GALAXY', scope,
        admin.ctn<Galaxy>().dagTree().setPermission(CHAT_NODE_ID, payload.sub, 'write'));
      const granted = await devAdmin.postUserMessage('now granted');
      expect(typeof granted).toBe('string');

      admin[Symbol.dispose](); devAdmin[Symbol.dispose]();
    });

    it('Subscriptions stores 0 for a granted `.dev` admin on the real host — and 1 for the covering admin (the un-skipped store-side half)', async () => {
      const scope = `cab-${crypto.randomUUID().slice(0, 8)}.app`;
      const { client: admin, accessToken } = await universeAdminClient(
        NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
        { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
      );
      admin.callGalaxySeedChatScript(scope, [
        { choices: [{ message: { content: 'seeded', reasoning_content: '', tool_calls: [] } }] },
      ], {});
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
      using adminSub = admin.resources.subscribeQuery(CHAT_QUERY); await adminSub.ready;
      const seeded = await admin.postUserMessage('seed the thread');
      await vi.waitFor(() => expect(adminSub.resourceIds.length).toBeGreaterThanOrEqual(2), { timeout: 15000 });

      const adminBrowser = new Browser();
      await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
      await createSubject(adminBrowser, scope, accessToken, 'devadmin@example.com');
      const { client: devAdmin, payload } = await createInvitedClient(
        NebulaClientTest, new Browser(), `${scope}.dev`, `${scope}.dev`, 'devadmin@example.com',
        CHAT_MESSAGE_ONTOLOGY_VERSION,
        { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
      );
      await admin.lmz.callAsync('GALAXY', scope,
        admin.ctn<Galaxy>().dagTree().setPermission(CHAT_NODE_ID, payload.sub, 'read'));

      // Both principals subscribe the same seeded Message. The `.dev` admin is admitted
      // by the grant; the covering admin by dominion — so the stored verdicts must
      // differ, which is what makes the 0 an assertion rather than the column's default.
      // The `.dev` leg is a DIRECT mesh call on the chat host: the public `resources.*`
      // API pins its instance to the session's own scope (aud-confinement), so the
      // convenience path cannot construct this caller — the escalation is a raw-caller
      // shape by nature, and the assertion below is server-side rows either way.
      await devAdmin.lmz.callAsync('GALAXY', scope,
        devAdmin.ctn<Galaxy>().subscribe(CHAT_MESSAGE_ONTOLOGY_VERSION, 'Message', seeded));
      using adminContent = admin.resources.subscribe('Message', seeded);
      await adminContent.snapshot;

      const rows = await (runInDurableObject as any)((env as any).GALAXY.getByName(scope),
        (_i: any, c: any) => c.storage.sql.exec(
          'SELECT clientId, dominionOverHostAtSubscribe FROM Subscribers WHERE resourceId = ?', seeded,
        ).toArray() as Array<{ clientId: string; dominionOverHostAtSubscribe: number }>);
      const devRow = rows.find((r) => r.clientId === devAdmin.lmz.instanceName);
      const adminRow = rows.find((r) => r.clientId === admin.lmz.instanceName);
      expect(devRow?.dominionOverHostAtSubscribe).toBe(0); // admitted by the grant, NOT as admin
      expect(adminRow?.dominionOverHostAtSubscribe).toBe(1); // the covering admin, as admin

      admin[Symbol.dispose](); devAdmin[Symbol.dispose]();
    });
  });
});
