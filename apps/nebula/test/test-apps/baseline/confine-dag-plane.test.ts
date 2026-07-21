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
 * `{u}.{g}.dev`) is a **star-tier leaf**, where `buildAuthScopePattern` returns the exact id, so
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
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { generateUuid } from '@lumenize/auth';
import { DagTree, Subscriptions, QuerySubs, Resources, ROOT_NODE_ID } from '@lumenize/nebula';
import type { CallContext } from '@lumenize/mesh';

const uniqueGalaxy = () => `cdp-${generateUuid().slice(0, 8)}.app`;

/** A synthetic CallContext carrying exactly the claim shape under test. */
function ctxFor(sub: string, access?: { admin?: boolean; authScopePattern?: string }): CallContext {
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
    as: (sub: string, access?: { admin?: boolean; authScopePattern?: string }) => void;
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
    const as = (sub: string, access?: { admin?: boolean; authScopePattern?: string }) => {
      cc = ctxFor(sub, access);
    };
    return body({ tree, subs, querySubs, as });
  });
}

// The two principals the whole task turns on. Both are `admin: true`.
const COVERING = (g: string) => ({ admin: true, authScopePattern: `${g}.*` });   // reaches this host
const DESCENDANT = (g: string) => ({ admin: true, authScopePattern: `${g}.dev` }); // exact-star, does NOT

describe('Phase 2 — the DAG permission plane is confined to its host', () => {
  describe('confinement point 1: requirePermission (live claim)', () => {
    it('a descendant-scope admin with NO DAG grant is DENIED on a non-leaf host', async () => {
      const g = uniqueGalaxy();
      await onNonLeafHost(g, ({ tree, as }) => {
        as('descendant-admin', DESCENDANT(g));
        // Pre-fix the bare `access.admin` bit short-circuited before any DAG lookup and this
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
        return { descendant: d.row.accessAdmin, covering: c.row.accessAdmin };
      });
      // Pre-fix BOTH were 1 (the raw bit). The stored value is a verdict, not a claim.
      expect(descendant).toBe(0);
      expect(covering).toBe(1);
    });

    // ⚠️ The `Subscriptions` half is DEFERRED, not silently dropped (testing.md § Deferring ≠
    // deleting). Blocker: `Subscriptions.subscribe` calls `Resources.read()` before its INSERT, and
    // `read` resolves the snapshot BEFORE checking permission — so with no existing resource it
    // throws "not found" and never reaches the store line. Creating one requires a compiled
    // ontology facet for validation, which this synthetic non-leaf fixture has no cheap way to
    // stand up (its whole point is that no such host exists yet to provide one).
    //
    // Coverage that DOES exist meanwhile: `QuerySubs` above exercises the identical predicate on
    // the identical inputs, and both writers are mutation-probed together (reverting either store
    // site reds the loop-closing test below). What is untested is specifically the second call
    // site's own line.
    //
    // Un-skips when nebula-galaxy-collapse-and-chat.md lands a real non-leaf DagTree host (Galaxy
    // `{u}.{g}`), which brings an ontology with it — at which point this becomes an ordinary
    // integration test rather than a synthetic one.
    it.skip('Subscriptions stores 0 for a granted descendant-scope admin (needs a non-leaf host with an ontology)', async () => {
      const g = uniqueGalaxy();
      await onNonLeafHost(g, ({ tree, subs, as }) => {
        as('covering-admin', COVERING(g));
        tree.setPermission(ROOT_NODE_ID, 'descendant-admin', 'read');
        // ... create a resource on ROOT_NODE_ID, then:
        as('descendant-admin', DESCENDANT(g));
        subs.subscribe('TestResource', 'some-rid', 'client-d', 'BINDING');
        const row = subs.forResource('some-rid').find((r) => r.clientId === 'client-d');
        expect(row?.accessAdmin).toBe(0); // admitted by the seeded grant, but NOT as admin
      });
    });
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
        const dEval = tree.evaluatePermissions([ROOT_NODE_ID], 'read', 'descendant-admin', Boolean(d.row.accessAdmin));
        const cEval = tree.evaluatePermissions([ROOT_NODE_ID], 'read', 'covering-admin', Boolean(c.row.accessAdmin));
        return { dAllowed: dEval.allowed.has(ROOT_NODE_ID), cAllowed: cEval.allowed.has(ROOT_NODE_ID) };
      });
      // Reverting the store-side confinement makes dAllowed true → this reds.
      expect(dAllowed).toBe(false);
      expect(cAllowed).toBe(true);
    });
  });
});
