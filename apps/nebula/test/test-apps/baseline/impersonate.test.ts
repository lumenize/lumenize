/**
 * `client.impersonate()` — an admin's client producing a working client that acts as another person.
 *
 * ADR-009 **rung 2** throughout, as the whole `baseline` lane is: real founding, real invite, real
 * server-issued login, real endpoint. No email hop, no client mint. (Rung 1 for impersonation
 * belongs to a `/live` scenario once the admin-debug UI exists; rung 1 would add only the email
 * transport, which nothing asserted here depends on.)
 *
 * ⚠️ **TTL choice is load-bearing in two opposite directions.** The client refreshes when a token is
 * within 30s of expiry, so a sub-30s token is *born* already due and re-mints during the child's own
 * construction. Tests that count mints must therefore stay comfortably ABOVE that window, while the
 * forced re-mint tests in `impersonate-lifetime.test.ts` want the opposite. Anything here that asserts
 * a mint count uses `SAFE_TTL`.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NebulaClientTest } from './index';
import { universeAdminClient, createInvitedClient, createSubject, browserLogin, ORIGIN, pageOf } from '../../test-helpers';
import { ImpersonationChainError, ImpersonationMintError, childrenOf } from '../../../src/impersonation';
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';

/** Comfortably outside the client's 30s refresh-ahead window, so construction does not re-mint. */
const SAFE_TTL = 300;

/** A universe admin plus a real invited non-admin member of a star beneath it. */
async function adminAndMember(memberEmail = 'member@example.com') {
  const universe = `imp-${crypto.randomUUID().slice(0, 8)}`;
  const star = `${universe}.app.tenant`;
  const browser = new Browser();

  const { client: admin, accessToken: adminToken, payload: adminPayload } = await universeAdminClient(
    NebulaClientTest, browser, star, star, 'admin@example.com',
  );
  await createSubject(browser, star, adminToken, memberEmail);
  const { payload: member } = await createInvitedClient(
    NebulaClientTest, new Browser(), star, star, memberEmail,
  );
  // Fixture guard: the subject really is a non-admin, which is what makes the mint authority-reducing.
  expect(member.access.scopeAdmin).toBeUndefined();
  return { universe, star, browser, admin, adminToken, adminPayload, member };
}

describe('impersonate() — identity', () => {
  it('returns a connected client that IS the subject, with the admin as actor', async () => {
    const { star, admin, adminPayload, member } = await adminAndMember();

    const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // Mutation: construct the child from the parent's own token instead of the mint response →
    // `claims.act` is absent → reds.
    expect(child.claims.sub).toBe(member.sub);
    expect(child.claims.profileId).toBe(member.profileId);
    expect(child.claims.act?.sub).toBe(adminPayload.sub);
    // Authority-REDUCING: the child carries the subject's (absent) admin bit, not the caller's.
    expect(child.claims.access.scopeAdmin).toBeUndefined();

    // ⚠️ `ready` is asserted by the UNGUARDED dereferences above, not by a separate null check: a
    // `expect(child.claims).not.toBeNull()` here could never red on its own, since `child.claims.sub`
    // three lines up would already have thrown. Mint-then-seed is what makes it hold — the seeded
    // token is parsed synchronously in the constructor, so claims exist before the caller has the
    // object.
    child.disconnect();
    admin.disconnect();
  });

  it('round-trips ttlSeconds into the minted token', async () => {
    const { star, admin, member } = await adminAndMember();
    const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // Mutation: accept `opts` and drop it before the request → the default lifetime comes back → reds.
    const { exp, iat } = child.claims as unknown as { exp: number; iat: number };
    expect(exp - iat).toBe(SAFE_TTL);
    child.disconnect();
    admin.disconnect();
  });
});

describe('impersonate() — the mint', () => {
  let sink: any[] = [];

  it('mints exactly once', async () => {
    const { star, admin, member } = await adminAndMember();
    sink = [];
    setDebugSink((e) => sink.push(e));
    try {
      const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

      const issued = sink.filter((e) =>
        e.namespace === 'nebula-auth.facade.impersonate' && e.message === 'Impersonation token issued'
        && e.data?.subOfNarrowerToken === member.sub);
      // Mutation: construct the child WITHOUT seeding the minted token → its eager connect finds no
      // token, `#needsTokenRefresh()` is true, and its `refresh` mints a second time → two markers.
      // That mutation is the plain reading of "constructs a client whose refresh calls the helper",
      // which is exactly why mint-then-seed is pinned rather than left to the builder.
      expect(issued).toHaveLength(1);
      child.disconnect();
      admin.disconnect();
    } finally { clearDebugSink(); }
  });

  it('refuses to chain — before any network call', async () => {
    // The witness is the FACADE's own `called` marker: every call that reaches `impersonate` logs one
    // before any check, so a refusal the facade would have answered still counts. A client-side
    // counter would have to know which client's transport the child would use; the server sees
    // every call whichever it is.
    const { admin, member } = await adminAndMember();
    const sink: any[] = [];
    setDebugSink((e) => sink.push(e));
    const calls = () => sink.filter((e) =>
      e.namespace === 'nebula-auth.facade.impersonate' && e.message === 'called').length;
    try {
      const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));
      // Fixture guard: the witness really is wired — the FIRST mint went through it. Without this,
      // a zero below would be indistinguishable from a marker attached to nothing.
      expect(calls()).toBeGreaterThanOrEqual(1);
      const afterFirstMint = calls();

      // Mutation: delete the guard → the call reaches the facade → the count rises → reds.
      await expect(child.impersonate(member.sub)).rejects.toThrow(ImpersonationChainError);
      await expect(child.impersonate(member.sub)).rejects.toThrow(/does not chain/i);
      expect(calls()).toBe(afterFirstMint);

      child.disconnect();
      admin.disconnect();
    } finally { clearDebugSink(); }
  });

  // TWO different refusals, on purpose: each carries the facade's own message through the typed
  // refusal into `ImpersonationMintError`, so a build that drops or fixes the message reds one row.
  //
  // The second row is the mint's COLLAPSED refusal: an absent subject and a subject the caller may
  // not act for answer identically (refusal-and-absence indistinguishability — a distinct answer
  // would be a `sub`-existence oracle). The first is the self-narrow rejection, which precedes the
  // lookup.
  it.each([
    ['self-narrowing (the caller\'s own sub)', 'self', /different sub/],
    ['an absent subject, indistinguishable from a refused one', 'absent', /does not administer this subject/],
  ])('a failed FIRST mint (%s) rejects cleanly and leaves no half-registered child',
    async (_label, kind, expectedMessage) => {
      const { admin, adminPayload } = await adminAndMember();
      expect(childrenOf(admin).length).toBe(0);

      const target = kind === 'absent' ? crypto.randomUUID() : adminPayload.sub;
      const rejected = admin.impersonate(target, { ttlSeconds: SAFE_TTL });
      await expect(rejected).rejects.toThrow(ImpersonationMintError);
      // Mutation: drop the facade's message when wrapping the typed refusal → both rows red.
      await expect(rejected).rejects.toThrow(expectedMessage);

      // A half-registered child would hold an open socket, the exact leak the `Set<WeakRef>`
      // rejection argues GC cannot close.
      // Mutation: register the child before the mint resolves → a failed mint leaves it → reds.
      expect(childrenOf(admin).length).toBe(0);
      admin.disconnect();
    });
});

describe('impersonate() — two children coexist', () => {
  // The ONLY criterion protecting two load-bearing decisions: "an admin may want two subjects live
  // at once" (which rejects a mode flag on one client) and the scope segment in the child's name.
  // The failure it catches is SILENT — the Gateway names one DO per instanceName, so a colliding
  // pair supersedes each other's socket rather than erroring.
  it('two different subjects, from one parent', async () => {
    const { star, admin, adminToken } = await adminAndMember('m1@example.com');
    // Each person in a browser of their own: one holding the admin's cookie as well would be the
    // admin on the star's page, since the refresh mints from the broadest admin membership.
    const { payload: m1 } = await browserLogin(new Browser(), star, 'm1@example.com', star);
    await createSubject(new Browser(), star, adminToken, 'm2@example.com');
    const { payload: m2 } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'm2@example.com',
    );

    const c1 = await admin.impersonate(m1.sub, { ttlSeconds: SAFE_TTL });
    const c2 = await admin.impersonate(m2.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(c1.connectionState).toBe('connected'));
    await vi.waitFor(() => expect(c2.connectionState).toBe('connected'));

    expect(c1.lmz.instanceName).not.toBe(c2.lmz.instanceName);
    expect(c1.claims.sub).toBe(m1.sub);
    expect(c2.claims.sub).toBe(m2.sub);
    expect(childrenOf(admin).length).toBe(2);
    c1.disconnect(); c2.disconnect(); admin.disconnect();
  });

});

describe('impersonate() — the child acts on its parent\'s page', () => {
  // No client names the impersonation scope: the child's `aud` is the caller's own. So a tenant
  // member is impersonated from that tenant's page, and from the galaxy's page the same mint is
  // refused, since the galaxy is outside the member's own scope.
  it('mints from the subject\'s own page, and the child\'s page is the parent\'s', async () => {
    const { star, admin, member } = await adminAndMember();
    const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));
    expect(child.claims.aud).toBe(star);
    child.disconnect();
    admin.disconnect();
  });

  // Called through the facade directly, since the client method takes no scope to pass. The extra
  // argument is what an old caller would send; the facade has no parameter for it.
  // Mutation: honour a third argument as the child's `aud` in the facade → the galaxy-page mint
  // succeeds → reds.
  it('refuses from the galaxy\'s page, whatever scope the call names', async () => {
    const universe = `imp-${crypto.randomUUID().slice(0, 8)}`;
    const galaxy = `${universe}.app`;
    const star = `${galaxy}.tenant`;
    const browser = new Browser();
    const { client: admin, accessToken: adminToken } = await universeAdminClient(
      NebulaClientTest, browser, galaxy, galaxy, 'admin@example.com',
    );
    await createSubject(browser, star, adminToken, 'member@example.com');
    const { payload: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'member@example.com',
    );
    const facade = admin.ctn<NebulaAuthFacade>() as any;
    await expect(admin.lmz.callAsync('NEBULA_AUTH_FACADE', undefined,
      facade.impersonate(member.sub, { ttlSeconds: SAFE_TTL }, star)))
      .rejects.toThrow(`This page's scope "${galaxy}" is outside the subject's own scope`);
    admin.disconnect();
  });
});

describe('impersonate() — the parent is untouched', () => {
  it('leaves the parent tab identity byte-identical', async () => {
    // ⚠️ The parent must be given an EXPLICIT context, because `browser.context(origin)` returns an
    // INDEPENDENT context per call ("sessionStorage is per-context") — reading a second one would
    // inspect empty storage and the assertion would pass vacuously no matter what the child did.
    const universe = `imp-${crypto.randomUUID().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();
    const ctx = browser.context(pageOf(star));
    const { client: admin, accessToken: adminToken } = await universeAdminClient(
      NebulaClientTest, browser, star, star, 'admin@example.com', 'v1',
      { sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel },
    );
    await createSubject(browser, star, adminToken, 'member@example.com');
    const { payload: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'member@example.com',
    );

    const before = ctx.sessionStorage.getItem('lmz_tab');
    expect(before).toBeTruthy(); // fixture guard: there IS a stored id to preserve

    const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // Mutation: let the child derive its own tabId via `getOrCreateTabId` → the duplicate-tab probe
    // fires and the child REWRITES the stored id → reds. Silent otherwise: the admin's client keeps
    // working this session and only loses continuity on a later reload.
    expect(ctx.sessionStorage.getItem('lmz_tab')).toBe(before);
    // And the child's name is built from the parent's tabId rather than a fresh one.
    expect(child.lmz.instanceName).toContain(before as string);
    child.disconnect();
    admin.disconnect();
  });
});
