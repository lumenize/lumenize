/**
 * Registry unit tests — NebulaAuthRegistry: discovery, existence (`Scopes`), admin-minting claim
 * flows, admin-gated in-session creation, scope-tree, and cascade deletion (sub-first).
 *
 * Uses Workers RPC to call registry methods directly (nebula-auth is raw-DO infrastructure). Each test
 * gets a FRESH registry (unique name) for isolation; identities/scopes for the deletion tests are
 * seeded via `runInDurableObject` (the surrogate `sub` is minted only at authority points, so there is
 * no `registerEmail` seam anymore).
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { AccessEntry, NebulaJwtPayload } from '@lumenize/nebula-auth';

/** A fresh, isolated registry stub (unique name → own migrated storage). */
function freshRegistry(): any {
  return env.NEBULA_AUTH_REGISTRY.getByName(`reg-${crypto.randomUUID()}`);
}

/** Seed `Scopes` + `Emails` + `Memberships` directly (bypassing the authority-point mint) for deletion
 *  tests. One `Emails` row per distinct address — which is the schema's rule, not a convenience: the
 *  same address in two scopes is ONE address row with two memberships, and seeding it any other way
 *  would build a shape the real mint cannot produce. */
async function seed(
  stub: any, scopes: string[], members: Array<{ sub: string; scope: string; email: string; scopeAdmin?: boolean }>,
): Promise<void> {
  // Ids the real mint supplies. Generated outside the callback (no crypto reliance inside it).
  const emailIds = new Map<string, { emailId: string; profileId: string }>();
  for (const m of members) {
    const lc = m.email.toLowerCase();
    if (!emailIds.has(lc)) emailIds.set(lc, { emailId: crypto.randomUUID(), profileId: crypto.randomUUID() });
  }
  const seeded = members.map(m => ({ ...m, lc: m.email.toLowerCase() }));
  await (runInDurableObject as any)(stub, (_i: any, ctx: any) => {
    for (const s of scopes) ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)', s);
    for (const [lc, ids] of emailIds) {
      ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO Emails (emailId, email, profileId, emailVerified, createdAt) VALUES (?,?,?,1,?)',
        ids.emailId, lc, ids.profileId, '2026-01-01T00:00:00.000Z',
      );
    }
    for (const m of seeded) {
      ctx.storage.sql.exec(
        'INSERT INTO Memberships (sub, emailId, universeGalaxyStarId, scopeAdmin, acceptedAt, createdAt) VALUES (?,?,?,?,?,?)',
        m.sub, emailIds.get(m.lc)!.emailId, m.scope, m.scopeAdmin ? 1 : 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      );
    }
  });
}

const ADMIN_OVER = (u: string): AccessEntry => ({ authScopePattern: `${u}.*`, scopeAdmin: true });

/** The ADR-016 acting-principal argument for a direct-RPC `executeScopeDeletion` call. Recorded,
 *  never consulted — authorization keys off the separate `callerSub`/`callerAccess` arguments. */
const ACTING = (sub: string, u: string) =>
  ({ sub, access: ADMIN_OVER(u) } as unknown as NebulaJwtPayload);

describe('NebulaAuthRegistry', () => {
  // ── discover ──────────────────────────────────────────────────────────────────────────────────
  describe('discover', () => {
    it('returns empty array for unknown email', async () => {
      expect(await freshRegistry().discover('nobody@example.com')).toEqual([]);
    });

    it('returns { universeGalaxyStarId, scopeAdmin } for a claimed universe admin (sub-FREE)', async () => {
      const r = freshRegistry();
      await r.claimUniverse('acme', 'scope-admin@example.com', 'http://localhost');
      const entries = await r.discover('scope-admin@example.com');
      expect(entries).toEqual([{ universeGalaxyStarId: 'acme', scopeAdmin: true }]);
      expect(entries[0]).not.toHaveProperty('sub'); // never leak the surrogate identity key
    });

    it('case-insensitive email lookup', async () => {
      const r = freshRegistry();
      await r.claimUniverse('caseu', 'FRANK@Example.COM', 'http://localhost');
      expect(await r.discover('frank@example.com')).toHaveLength(1);
    });

    it('returns all scopes for an email across universes', async () => {
      const r = freshRegistry();
      await r.claimUniverse('one', 'carol@example.com', 'http://localhost');
      await r.claimUniverse('two', 'carol@example.com', 'http://localhost');
      const names = (await r.discover('carol@example.com')).map((e: any) => e.universeGalaxyStarId).sort();
      expect(names).toEqual(['one', 'two']);
    });
  });

  // ── getAndVerifyIdentity — find-and-flip, reject if none ─────────────────────────────────────────
  describe('getAndVerifyIdentity', () => {
    it('returns null when no identity exists (login verify never mints)', async () => {
      expect(await freshRegistry().getAndVerifyIdentity('ghost@example.com', 'acme')).toBeNull();
    });

    it('find-and-flips an existing identity → returns { sub, scope, scopeAdmin } and sets emailVerified', async () => {
      const r = freshRegistry();
      await r.claimUniverse('flipu', 'scope-admin@example.com', 'http://localhost'); // mints the admin identity (emailVerified=0)
      const identity = await r.getAndVerifyIdentity('scope-admin@example.com', 'flipu');
      expect(identity).toMatchObject({ universeGalaxyStarId: 'flipu', scopeAdmin: true });
      expect(identity.sub).toBeDefined();
    });
  });

  // ── checkSlugAvailable (Scopes existence) ───────────────────────────────────────────────────────
  describe('checkSlugAvailable', () => {
    it('true for unused, false after a Scopes row exists', async () => {
      const r = freshRegistry();
      expect(await r.checkSlugAvailable('brand-new')).toBe(true);
      await r.claimUniverse('taken', 'x@example.com', 'http://localhost');
      expect(await r.checkSlugAvailable('taken')).toBe(false);
    });
  });

  // ── claimUniverse (admin-minting self-signup) ─────────────────────────────────────────────────
  describe('claimUniverse', () => {
    it('claims a universe, mints the claiming admin identity, and returns the magic link', async () => {
      const r = freshRegistry();
      const result = await r.claimUniverse('my-universe', 'scope-admin@example.com', 'http://localhost');
      expect(result.magicLinkUrl).toContain('/auth/my-universe/magic-link');
      expect(await r.checkSlugAvailable('my-universe')).toBe(false);
      expect(await r.discover('scope-admin@example.com')).toEqual([{ universeGalaxyStarId: 'my-universe', scopeAdmin: true }]);
    });

    it('rejects duplicate / reserved / invalid slug / invalid email', async () => {
      const r = freshRegistry();
      await r.claimUniverse('taken-univ', 'first@example.com', 'http://localhost');
      await expect(r.claimUniverse('taken-univ', 'second@example.com', 'http://localhost')).rejects.toThrow(/already claimed/);
      await expect(r.claimUniverse('nebula-platform', 'h@example.com', 'http://localhost')).rejects.toThrow(/reserved/);
      await expect(r.claimUniverse('INVALID SLUG!', 'x@example.com', 'http://localhost')).rejects.toThrow(/Invalid/);
      await expect(r.claimUniverse('email-val', 'not-an-email', 'http://localhost')).rejects.toThrow(/invalid.*email/i);
    });
  });

  // Two ways a star comes into being, and they partition cleanly by slug class:
  //   claimStar   — OPEN self-signup. Mints an exact-star `scopeAdmin` star-scoped admin + emails a claim link.
  //                 Rejects reserved env names (`dev`). Tenant stars only.
  //   createStar  — admin-gated over the parent galaxy, `Scopes` row only, NO admin identity. The only
  //                 no-identity path, which is exactly what `{u}.{g}.dev` needs.
  // The open claim is safe because a star-scoped admin's exact-star pattern is inert above its own Star
  // (ADR-015: dominion flows strictly downward) — see tasks/archive/nebula-star-founder-provisioning.md.

  // ── createGalaxy (Scopes-only, admin-gated) ─────────────────────────────────────────────────────
  describe('createGalaxy', () => {
    it('creates a galaxy Scopes row under an existing universe (no identity minted)', async () => {
      const r = freshRegistry();
      await r.claimUniverse('gal-univ', 'admin@example.com', 'http://localhost');
      const result = await r.createGalaxy('gal-univ.my-galaxy', ADMIN_OVER('gal-univ'));
      expect(result.instanceName).toBe('gal-univ.my-galaxy');
      expect(await r.checkSlugAvailable('gal-univ.my-galaxy')).toBe(false);
      // wildcard-managed: no identity minted in the galaxy.
      expect(await r.discover('admin@example.com')).toEqual([{ universeGalaxyStarId: 'gal-univ', scopeAdmin: true }]);
    });

    it('rejects non-admin / nonexistent-parent / non-galaxy tier / wrong-scope / duplicate', async () => {
      const r = freshRegistry();
      await r.claimUniverse('gu', 'x@example.com', 'http://localhost');
      await expect(r.createGalaxy('gu.g', { authScopePattern: 'gu.*', scopeAdmin: false })).rejects.toThrow(/admin access/);
      await expect(r.createGalaxy('nonexistent.g', ADMIN_OVER('nonexistent'))).rejects.toThrow(/does not exist/);
      await expect(r.createGalaxy('just-a-universe', { authScopePattern: '*', scopeAdmin: true })).rejects.toThrow(/2-segment/);
      await expect(r.createGalaxy('gu.g', { authScopePattern: 'other.*', scopeAdmin: true })).rejects.toThrow(/admin access/);
      await r.createGalaxy('gu.g', ADMIN_OVER('gu'));
      await expect(r.createGalaxy('gu.g', ADMIN_OVER('gu'))).rejects.toThrow(/already claimed/);
    });
  });

  // ── createStar (in-session, no email) + myScopeTree ─────────────────────────────────────────────
  describe('createStar (in-session) + myScopeTree', () => {
    async function galaxy(r: any, u: string) {
      await r.claimUniverse(u, 'owner@example.com', 'http://localhost');
      await r.createGalaxy(`${u}.app`, ADMIN_OVER(u));
    }

    it('creates a .dev star Scopes row in-session — NO email round-trip', async () => {
      const r = freshRegistry();
      await galaxy(r, 'cs-ok');
      const result = await r.createStar('cs-ok.app.dev', ADMIN_OVER('cs-ok'));
      expect(result).toEqual({ instanceName: 'cs-ok.app.dev' });
      expect((result as any).magicLinkUrl).toBeUndefined();
      expect(await r.checkSlugAvailable('cs-ok.app.dev')).toBe(false);
    });

    it('rejects non-galaxy-admin / nonexistent parent / non-star tier', async () => {
      const r = freshRegistry();
      await galaxy(r, 'cs-x');
      await expect(r.createStar('cs-x.app.dev', { authScopePattern: 'cs-x.*', scopeAdmin: false })).rejects.toThrow(/not an admin of the parent galaxy/);
      await expect(r.createStar('cs-noparent.app.dev', { authScopePattern: '*', scopeAdmin: true })).rejects.toThrow(/does not exist/);
      await expect(r.createStar('cs-bad.app', { authScopePattern: '*', scopeAdmin: true })).rejects.toThrow(/3-segment/);
    });

    it('myScopeTree returns the universe + descendants (tier + isDev); [] for a non-admin; scoped to the caller', async () => {
      const r = freshRegistry();
      await galaxy(r, 'cs-tree');
      await r.createStar('cs-tree.app.dev', ADMIN_OVER('cs-tree'));
      const tree = await r.myScopeTree(ADMIN_OVER('cs-tree'));
      expect(tree.map((s: any) => s.instanceName).sort()).toEqual(['cs-tree', 'cs-tree.app', 'cs-tree.app.dev']);
      expect(tree.find((s: any) => s.instanceName === 'cs-tree.app.dev')).toEqual({ instanceName: 'cs-tree.app.dev', tier: 'star', isDev: true });
      expect(await r.myScopeTree({ authScopePattern: 'cs-tree.*', scopeAdmin: false })).toEqual([]);
      const exact = await r.myScopeTree({ authScopePattern: 'cs-tree.app.dev', scopeAdmin: true });
      expect(exact.map((s: any) => s.instanceName)).toEqual(['cs-tree.app.dev']);
    });
  });

  // ── scope deletion (cascade teardown — sub-first) ───────────────────────────────────────────────
  describe('scope deletion (cascade teardown)', () => {
    it('plan: a solo `.dev` star → affected is just that star, no attached users (carries tier + isDev)', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      await seed(r, ['d1.app.dev'], [{ sub: owner, scope: 'd1.app.dev', email: 'o@x.com', scopeAdmin: true }]);
      const plan = await r.planScopeDeletion('d1.app.dev', owner, ADMIN_OVER('d1'));
      expect(plan.affectedUsers).toEqual({ total: 0, sample: [] });
      expect(plan.affected).toEqual([{ instanceName: 'd1.app.dev', tier: 'star', isDev: true }]);
    });

    // Deletion cascades DOWN only — the prune-up was REMOVED. This test used to assert the opposite
    // ("prune-up wipes a registered ancestor left empty + user-less"); it now pins that an emptied
    // ancestor SURVIVES. Case 1 is the one that reds against the old prune-up code.
    it('plan: an EMPTY ancestor left behind is NOT wiped — the cascade never climbs', async () => {
      const r1 = freshRegistry();
      const owner = crypto.randomUUID();
      await seed(r1, ['d3', 'd3.app.dev'], [
        { sub: owner, scope: 'd3', email: 'o@x.com', scopeAdmin: true },
        { sub: crypto.randomUUID(), scope: 'd3.app.dev', email: 'o@x.com', scopeAdmin: true },
      ]);
      // `d3` is the only-parent of the only-child being deleted, holds no OTHER user, and the caller
      // admins it — every condition the prune-up used to fire on. It must still survive.
      const plan = await r1.planScopeDeletion('d3.app.dev', owner, ADMIN_OVER('d3'));
      expect(plan.affected.map((a: any) => a.instanceName)).toEqual(['d3.app.dev']);

      const r2 = freshRegistry();
      const owner2 = crypto.randomUUID();
      await seed(r2, ['d4', 'd4.app.dev', 'd4.app.other'], [
        { sub: owner2, scope: 'd4', email: 'o@x.com', scopeAdmin: true },
        { sub: crypto.randomUUID(), scope: 'd4.app.dev', email: 'o@x.com', scopeAdmin: true },
        { sub: crypto.randomUUID(), scope: 'd4.app.other', email: 'o@x.com', scopeAdmin: true },
      ]);
      const plan2 = await r2.planScopeDeletion('d4.app.dev', owner2, ADMIN_OVER('d4'));
      expect(plan2.affected.map((a: any) => a.instanceName)).toEqual(['d4.app.dev']);
    });

    it('plan and execute agree — a vanished identity cannot enlarge the wipe set', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      const otherSub = crypto.randomUUID();
      await seed(r, ['d9', 'd9.app.dev'], [
        { sub: owner, scope: 'd9', email: 'o@x.com', scopeAdmin: true },
        { sub: otherSub, scope: 'd9.app.dev', email: 'other@x.com', scopeAdmin: false },
      ]);
      const planned = await r.planScopeDeletion('d9.app.dev', owner, ADMIN_OVER('d9'));
      expect(planned.affectedUsers.total).toBe(1);

      // The attached identity disappears between confirm and execute — the window the removed 409
      // used to mask. With the prune-up gone, `affected` is `down` and cannot grow.
      await (runInDurableObject as any)(r, (_i: any, ctx: any) => {
        ctx.storage.sql.exec('DELETE FROM Memberships WHERE sub = ?', otherSub);
      });

      const executed = await r.executeScopeDeletion('d9.app.dev', owner, ADMIN_OVER('d9'), ACTING(owner, 'd9'));
      expect(executed.affected.map((a: any) => a.instanceName)).toEqual(['d9.app.dev']);
    });

    it('plan: deleting a higher node cascades DOWN to descendants', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      await seed(r, ['d2', 'd2.app.dev'], [{ sub: owner, scope: 'd2', email: 'o@x.com', scopeAdmin: true }]);
      const plan = await r.planScopeDeletion('d2', owner, ADMIN_OVER('d2'));
      expect(plan.affected.map((a: any) => a.instanceName).sort()).toEqual(['d2', 'd2.app.dev']);
    });

    // Renamed from "another user on the target BLOCKS the delete": under ADR-015 an attached user is
    // a WARNING, never a refusal. The old title asserted the opposite of the shipped behavior.
    it('warning: another user on the target is reported, and the delete still succeeds', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      await seed(r, ['d5.app.dev'], [
        { sub: owner, scope: 'd5.app.dev', email: 'owner@x.com', scopeAdmin: true },
        { sub: crypto.randomUUID(), scope: 'd5.app.dev', email: 'other@x.com', scopeAdmin: false },
      ]);
      const plan = await r.planScopeDeletion('d5.app.dev', owner, ADMIN_OVER('d5'));
      expect(plan.affectedUsers).toEqual({
        total: 1, sample: [{ instanceName: 'd5.app.dev', email: 'other@x.com' }],
      });
      // Reds against the removed `409 scope_in_use`: the attached user no longer refuses the delete.
      const executed = await r.executeScopeDeletion('d5.app.dev', owner, ADMIN_OVER('d5'), ACTING(owner, 'd5'));
      expect(executed.affected.map((a: any) => a.instanceName)).toEqual(['d5.app.dev']);
    });

    it('warning is BOUNDED — >25 attached users yield a full count and a <=25 sample', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      const members = [{ sub: owner, scope: 'd8.app.dev', email: 'owner@x.com', scopeAdmin: true }];
      for (let i = 0; i < 30; i++) {
        members.push({
          sub: crypto.randomUUID(), scope: 'd8.app.dev',
          email: `u${String(i).padStart(2, '0')}@x.com`, scopeAdmin: false,
        });
      }
      await seed(r, ['d8.app.dev'], members);
      const plan = await r.planScopeDeletion('d8.app.dev', owner, ADMIN_OVER('d8'));
      expect(plan.affectedUsers.total).toBe(30);                 // the full count, not the sample size
      expect(plan.affectedUsers.sample).toHaveLength(25);        // reds if the plan carries every email
      expect(plan.affectedUsers.sample.every((b: any) => b.instanceName === 'd8.app.dev')).toBe(true);
    });

    it('execute: solo delete removes the rows (discover empty, slug free)', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      await seed(r, ['d6.app.dev'], [{ sub: owner, scope: 'd6.app.dev', email: 'solo@x.com', scopeAdmin: true }]);
      const result = await r.executeScopeDeletion('d6.app.dev', owner, ADMIN_OVER('d6'), ACTING(owner, 'd6'));
      expect(result.affected.map((a: any) => a.instanceName)).toEqual(['d6.app.dev']);
      expect(await r.discover('solo@x.com')).toEqual([]);
      expect(await r.checkSlugAvailable('d6.app.dev')).toBe(true);
    });

    it('authz: a non-admin / wrong-scope caller is rejected (403); reserved platform cannot be deleted', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      await seed(r, ['d8.app.dev'], [{ sub: owner, scope: 'd8.app.dev', email: 'o@x.com', scopeAdmin: true }]);
      await expect(r.planScopeDeletion('d8.app.dev', owner, { authScopePattern: 'd8.*', scopeAdmin: false })).rejects.toThrow(/not an admin/);
      await expect(r.planScopeDeletion('d8.app.dev', owner, { authScopePattern: 'other.*', scopeAdmin: true })).rejects.toThrow(/not an admin/);
      await expect(r.planScopeDeletion('nebula-platform', owner, { authScopePattern: '*', scopeAdmin: true })).rejects.toThrow(/cannot be deleted/);
    });

    // Retitled: the prune-up is gone, so "does not prune" now holds for EVERY caller and would be a
    // duplicate of the cascade-never-climbs test above. What this uniquely covers is the AUTHZ shape —
    // an exact-star (non-wildcard) pattern satisfying `#hasDominionOver` on its own star.
    it('authz: an exact-star (non-wildcard) pattern can delete its own star', async () => {
      const r = freshRegistry();
      const owner = crypto.randomUUID();
      await seed(r, ['d9', 'd9.app.dev'], [
        { sub: owner, scope: 'd9.app.dev', email: 'o@x.com', scopeAdmin: true },
      ]);
      const plan = await r.planScopeDeletion('d9.app.dev', owner, { authScopePattern: 'd9.app.dev', scopeAdmin: true });
      expect(plan.affected.map((a: any) => a.instanceName)).toEqual(['d9.app.dev']);
    });

    it('fail-closed (M2): a callerSub with no identity is refused (403), never "no other users → wipe"', async () => {
      const r = freshRegistry();
      await seed(r, ['d10.app.dev'], [{ sub: crypto.randomUUID(), scope: 'd10.app.dev', email: 'o@x.com', scopeAdmin: true }]);
      await expect(
        r.planScopeDeletion('d10.app.dev', 'ghost-sub', ADMIN_OVER('d10')),
      ).rejects.toThrow(/not found|forbidden/i);
    });
  });
});
