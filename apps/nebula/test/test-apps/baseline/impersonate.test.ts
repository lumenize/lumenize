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
 * construction. Tests that count mints must therefore stay comfortably ABOVE that window; Phase 3's
 * forced-re-mint test wants the opposite. Anything here that asserts a mint count uses
 * `SAFE_TTL`.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { generateUuid } from '@lumenize/auth';
import { NebulaClientTest } from './index';
import {
  universeAdminClient, createInvitedClient, createSubject, browserLogin,
} from '../../test-helpers';
import { ImpersonationChainError, ImpersonationMintError, childCount } from '../../../src/impersonation';

const ORIGIN = 'http://localhost'; // must match test-helpers.ts's ORIGIN — the clients' real baseUrl
/** Comfortably outside the client's 30s refresh-ahead window, so construction does not re-mint. */
const SAFE_TTL = 300;

/** A universe admin plus a real invited non-admin member of a star beneath it. */
async function adminAndMember(memberEmail = 'member@example.com') {
  const universe = `imp-${generateUuid().slice(0, 8)}`;
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
  expect(member.access.admin).toBeUndefined();
  return { universe, star, browser, admin, adminToken, adminPayload, member };
}

describe('impersonate() — identity', () => {
  it('returns a connected client that IS the subject, with the admin as actor', async () => {
    const { star, admin, adminPayload, member } = await adminAndMember();

    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // Mutation: construct the child from the parent's own token instead of the mint response →
    // `claims.act` is absent → reds.
    expect(child.claims.sub).toBe(member.sub);
    expect(child.claims.profileId).toBe(member.profileId);
    expect(child.claims.act?.sub).toBe(adminPayload.sub);
    // Authority-REDUCING: the child carries the subject's (absent) admin bit, not the caller's.
    expect(child.claims.access.admin).toBeUndefined();

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
    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
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
      const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

      const issued = sink.filter((e) =>
        e.namespace === 'nebula-auth.worker.narrower.issued'
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
    // ⚠️ The counter must be on the PARENT's `fetch`, because the child INHERITS it — that is the
    // transport `child.impersonate()` would use. Counting on a separate client built alongside would
    // count nothing, and the "no network call" assertion would pass no matter what the guard did.
    const universe = `imp-${generateUuid().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();
    let mintRequests = 0;
    const counting = ((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (String(url).includes('/mint-narrower-token')) mintRequests++;
      return browser.fetch(input, init);
    }) as typeof fetch;
    const { client: admin, accessToken: adminToken } = await universeAdminClient(
      NebulaClientTest, browser, star, star, 'admin@example.com', 'v1', { fetch: counting },
    );
    await createSubject(browser, star, adminToken, 'member@example.com');
    const { payload: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'member@example.com',
    );

    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));
    // Fixture guard: the counter really is wired — the FIRST mint went through it. Without this, a
    // zero below would be indistinguishable from a counter attached to nothing.
    expect(mintRequests).toBeGreaterThanOrEqual(1);
    const afterFirstMint = mintRequests;

    // The instrument has to be a REQUEST COUNTER, not the debug sink: the endpoint's root-identity
    // gate returns a bare errorResponse with NO marker (unlike the non-admin branch, which emits
    // `narrower.denied`), so the sink cannot tell "never called" from "called and refused".
    // Mutation: delete the guard → the call reaches the endpoint → the count rises → reds.
    await expect(child.impersonate(member.sub, star)).rejects.toThrow(ImpersonationChainError);
    await expect(child.impersonate(member.sub, star)).rejects.toThrow(/does not chain/i);
    expect(mintRequests).toBe(afterFirstMint);

    child.disconnect();
    admin.disconnect();
  });

  // TWO different refusals, on purpose. Asserting one status could be satisfied by a build that
  // hard-codes it; two prove the mapping TRANSPORTS `res.status` and `error_description` rather than
  // coinciding with a constant. Nothing else exercises that mapping — the classification test builds
  // `ImpersonationMintError` by hand, so it covers the predicate, not the extraction.
  //
  // Both are reachable and their gate order is why: the endpoint checks caller reach and the admin
  // bit BEFORE it looks the subject up, so an out-of-reach scope 403s while an in-reach scope with a
  // nonexistent subject reaches the 404.
  it.each([
    ['403 — activeScope outside the caller\'s reach', 403, /exceeds the caller's reach/],
    ['404 — no such subject', 404, /Subject not found/],
  ])('a failed FIRST mint (%s) rejects cleanly and leaves no half-registered child',
    async (_label, expectedStatus, expectedMessage) => {
      const { star, admin, member } = await adminAndMember();
      expect(childCount(admin)).toBe(0);

      const target = expectedStatus === 404
        ? { sub: generateUuid(), scope: star }                                  // in reach, absent subject
        : { sub: member.sub, scope: `imp-${generateUuid().slice(0, 8)}.app.other` }; // foreign universe

      const rejected = admin.impersonate(target.sub, target.scope, { ttlSeconds: SAFE_TTL });
      await expect(rejected).rejects.toThrow(ImpersonationMintError);
      // Mutation: map every failure to a fixed status, or drop `error_description` from the message
      // → one of these two rows reds. (The previous `status: expect.any(Number)` could not: the
      // constructor assigns a number unconditionally, so it restated the class's own invariant.)
      await expect(rejected).rejects.toMatchObject({ status: expectedStatus });
      await expect(rejected).rejects.toThrow(expectedMessage);

      // ⚠️ Not an edge case: the design deliberately does NO client-side `activeScope` validation, so
      // a wrong scope is an EXPECTED caller error. A half-registered child would hold an open socket,
      // the exact leak the `Set<WeakRef>` rejection argues GC cannot close.
      // Mutation: register the child before the mint resolves → a failed mint leaves it → reds.
      expect(childCount(admin)).toBe(0);
      admin.disconnect();
    });
});

describe('impersonate() — two children coexist', () => {
  // The ONLY criterion protecting two load-bearing decisions: "an admin may want two subjects live
  // at once" (which rejects a mode flag on one client) and the scope segment in the child's name.
  // The failure it catches is SILENT — the Gateway names one DO per instanceName, so a colliding
  // pair supersedes each other's socket rather than erroring.
  it('two different subjects, from one parent', async () => {
    const { star, browser, admin, adminToken } = await adminAndMember('m1@example.com');
    const { payload: m1 } = await browserLogin(browser, star, 'm1@example.com', star);
    await createSubject(browser, star, adminToken, 'm2@example.com');
    const { payload: m2 } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'm2@example.com',
    );

    const c1 = await admin.impersonate(m1.sub, star, { ttlSeconds: SAFE_TTL });
    const c2 = await admin.impersonate(m2.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(c1.connectionState).toBe('connected'));
    await vi.waitFor(() => expect(c2.connectionState).toBe('connected'));

    expect(c1.lmz.instanceName).not.toBe(c2.lmz.instanceName);
    expect(c1.claims.sub).toBe(m1.sub);
    expect(c2.claims.sub).toBe(m2.sub);
    expect(childCount(admin)).toBe(2);
    c1.disconnect(); c2.disconnect(); admin.disconnect();
  });

  it('ONE subject at two different activeScopes — the case the scope segment exists for', async () => {
    // ⚠️ The subject must be a UNIVERSE-scoped identity, and that is the whole fixture. `#mintIdentity`
    // keys on (email, scope), so inviting the same address into two stars yields two DIFFERENT `sub`s
    // — and then the child names differ by the *sub* segment, so dropping the scope segment still
    // passes and the test proves nothing. (It did: the first draft of this test stayed green under
    // exactly that mutation.) A universe-scoped subject has one `sub` whose reach pattern covers both
    // stars, which is the only way to get one identity at two `activeScope`s.
    const universe = `imp-${generateUuid().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const star2 = `${universe}.app.tenant2`;
    const browser = new Browser();
    const { client: admin, accessToken: adminToken } = await universeAdminClient(
      NebulaClientTest, browser, universe, universe, 'admin@example.com',
    );
    await createSubject(browser, universe, adminToken, 'wide@example.com');
    const { payload: subject } = await createInvitedClient(
      NebulaClientTest, new Browser(), universe, universe, 'wide@example.com',
    );

    const a = await admin.impersonate(subject.sub, star, { ttlSeconds: SAFE_TTL });
    const b = await admin.impersonate(subject.sub, star2, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(a.connectionState).toBe('connected'));
    await vi.waitFor(() => expect(b.connectionState).toBe('connected'));

    // Same person, two scopes — so the ONLY thing distinguishing the two Gateway DO names is the
    // scope segment. Mutation: drop it → the names collide, the pair supersedes each other's socket,
    // and one never reaches `connected` → reds.
    expect(a.claims.sub).toBe(subject.sub);
    expect(b.claims.sub).toBe(subject.sub);
    expect(a.lmz.instanceName).not.toBe(b.lmz.instanceName);
    a.disconnect(); b.disconnect(); admin.disconnect();
  });
});

describe('impersonate() — the parent is untouched', () => {
  it('leaves the parent tab identity byte-identical', async () => {
    // ⚠️ The parent must be given an EXPLICIT context, because `browser.context(origin)` returns an
    // INDEPENDENT context per call ("sessionStorage is per-context") — reading a second one would
    // inspect empty storage and the assertion would pass vacuously no matter what the child did.
    const universe = `imp-${generateUuid().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();
    const ctx = browser.context(ORIGIN);
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

    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
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
