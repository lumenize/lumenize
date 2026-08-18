/**
 * `/mint-narrower-token` — the ADMIN branch (the `AuthorizedActor` non-admin path is CUT by
 * tasks/nebula-auth-surrogate-sub.md). Driven through the Worker on the SCOPE-LESS route; the
 * authorize line (root identity ∧ different sub ∧ `canMintFor`), the mirror mint, the `aud`
 * validation and its order (security.md § Delegation, mint-side) are the load-bearing cases.
 *
 * The cross-scope tests mint caller tokens via `createNebulaTestToken` (ADR-009 rung 3, justified —
 * this file is testing.md's canonical cross-scope-fixture example): a same-scope fixture cannot tell
 * "bind to the caller's scope" from "bind to the issuing scope".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import {
  foundUniverse, inviteAndLogin, mintNarrowerRequest, url,
  foundStarAndLogin, inviteIntoGalaxy, platformLogin, BOOTSTRAP_EMAIL, SECOND_BOOTSTRAP_EMAIL,
  registryUrl,
} from './test-helpers';
import { createNebulaTestToken } from '../src/create-nebula-test-token';
import { isAtOrAbove } from '../src/parse-id';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

// ── The OLD surface is gone (the coordinated wire-contract rename) ────────────────────────────────
// Both assertions are capable of failing: an `actFor` alias reds the first, and a `delegated-token`
// entry in the route-pipeline table reds the second.
describe('the pre-rename surface is gone', () => {
  it('the old BODY FIELD is gone — `{ actFor }` on the new route → 400 subOfNarrowerToken required', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

    const resp = await mintNarrowerRequest(SELF, admin.access_token, { actFor: user.parsed.sub, activeScope: u });
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string; error_description: string };
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe('subOfNarrowerToken required');
  });

  it('the old ROUTE is gone — POST /delegated-token with NO Bearer → 404, not 401', async () => {
    // The no-Bearer probe is what discriminates: a route registered in the pipeline table would
    // reach `verifyJwtGuard` and answer 401. A 404 proves the suffix has no table entry.
    const u = uni();
    const resp = await SELF.fetch(new Request(url(u, 'delegated-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subOfNarrowerToken: 'x', activeScope: u }),
    }));
    expect(resp.status).toBe(404);
  });
});

describe('/mint-narrower-token (admin branch only)', () => {
  // ── FAITHFULNESS, the `admin` mirror ────────────────────────────────────────────────────────────
  // Was: "admin bit = CALLER". Inverted deliberately — the caller's bit is what made the token act
  // with admin-derived dominion the subject may not have, so `dag-tree.ts`'s scope-admin bypass fired
  // and the denial an admin came to observe never happened.
  // Mutation: revert `scopeAdmin` to `payload.access.scopeAdmin === true` → this reds.
  it('an admin mints for a member — sub=subject, act.sub=caller, admin bit MIRRORS the subject (P1)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com'); // non-admin member

    const resp = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: user.parsed.sub, activeScope: u });
    expect(resp.status).toBe(200);
    const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
    expect(parsed.sub).toBe(user.parsed.sub);       // the subject
    expect(parsed.act.sub).toBe(admin.parsed.sub);  // the real actor
    // `user` is `scopeAdmin=0`, so the mirror leaves the bit ABSENT (it is omitted, never `false`).
    expect(parsed.access.scopeAdmin).toBeUndefined();
  });

  // The P2 twin — the same mirror, with a subject who really IS an admin. Without this, an
  // implementation that hard-codes `scopeAdmin: false` would pass the test above.
  it('...and MIRRORS a TRUE bit for an admin subject — a `claimStar` star-scoped admin (P2)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const star = `${u}.app.tenant`;
    // A star-scoped admin is the only real path to a sub-universe `scopeAdmin=1` identity.
    const starAdmin = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
    expect(starAdmin.parsed.access.scopeAdmin).toBe(true); // fixture guard — else the assertion below is vacuous

    const resp = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: starAdmin.parsed.sub, activeScope: star });
    expect(resp.status).toBe(200);
    const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
    expect(parsed.sub).toBe(starAdmin.parsed.sub);
    expect(parsed.access.scopeAdmin).toBe(true);
    expect(parsed.access.authScope).toBe(star); // exact-star — the SUBJECT's own membership scope
  });

  // ── SELF-NARROWING is rejected ──────────────────────────────────────────────────────────────────
  // Mutation: delete the check → 200 with `act.sub === sub` → this reds.
  it('rejects SELF-narrowing — an admin minting for their OWN sub → 400', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');

    const resp = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: admin.parsed.sub, activeScope: u });
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_request');
  });

  it('a non-admin caller cannot mint a narrower token (403) — the authorized-actor path is gone', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const scope = `${u}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    const other = await inviteAndLogin(SELF, scope, admin.access_token, 'other@example.com');

    const resp = await mintNarrowerRequest(SELF, member.access_token, { subOfNarrowerToken: other.parsed.sub, activeScope: scope });
    expect(resp.status).toBe(403);
  });

  // ── Refusal and absence are INDISTINGUISHABLE ───────────────────────────────────────────────────
  // The subject lookup precedes authorization, so a distinct not-found answer would make this route
  // a `sub`-existence oracle for any authenticated caller — one singleton RPC per probe. Reds
  // against carrying the old `404 not_found` across, and against any refusal body that varies with
  // whether the subject exists.
  it('a caller without dominion cannot tell a real subject from an absent one — same 403, same body', async () => {
    const u1 = uni();
    const u2 = uni();
    const admin1 = await foundUniverse(SELF, u1, 'admin1@example.com');
    const admin2 = await foundUniverse(SELF, u2, 'admin2@example.com'); // real, but not admin1's to act for

    const absent = await mintNarrowerRequest(SELF, admin1.access_token,
      { subOfNarrowerToken: 'no-such-sub', activeScope: u1 });
    const realButRefused = await mintNarrowerRequest(SELF, admin1.access_token,
      { subOfNarrowerToken: admin2.parsed.sub, activeScope: u1 });

    expect(absent.status).toBe(403);
    expect(realButRefused.status).toBe(403);
    expect(await absent.text()).toBe(await realButRefused.text()); // byte-equal bodies
  });

  // ── (1) ELIGIBILITY ─────────────────────────────────────────────────────────────────────────────
  describe('eligibility — you may only impersonate someone you already administer entirely', () => {
    // THE case eligibility uniquely rejects: UPWARD. A star-tier admin wearing a galaxy-tier
    // identity. The aud validation (`isAtOrAbove('u.g','u.g.s')`) holds, so ONLY `canMintFor` can
    // produce this 403 — and only this stops a lower admin wearing a superior's identity.
    // Mutation: make `canMintFor` reflexively true (its own scope as the second argument) → the
    // mint succeeds → this reds. That is the substitution the named wrapper exists to foreclose.
    it('UPWARD: a star-tier admin cannot mint for a galaxy-tier subject (403 forbidden)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const galaxy = `${u}.app`;
      const star = `${galaxy}.tenant`;

      // Caller: a star-scoped admin — exact-star pattern `u.app.tenant`, `admin: true`.
      const caller = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
      expect(caller.parsed.access.authScope).toBe(star); // fixture guard: NOT a wildcard
      // Subject: a member whose OWN scope is the parent galaxy — strictly above the caller.
      const subject = await inviteIntoGalaxy(SELF, galaxy, admin.access_token, 'gal-member@example.com');

      const resp = await mintNarrowerRequest(SELF, caller.access_token, { subOfNarrowerToken: subject.parsed.sub, activeScope: star });
      expect(resp.status).toBe(403);
      const body = await resp.json() as { error: string; error_description: string };
      expect(body.error).toBe('forbidden');
      // ADR-008: the refusal must not disclose where the subject sits in the tree. Asserted as an
      // EXACT echo of the caller's own pattern rather than `not.toContain(galaxy)` — in the upward
      // case the subject's scope is by construction an ancestor path of the caller's own pattern, so
      // a substring check can never distinguish "leaked it" from "echoed what the caller already
      // holds". Adding the subject's scope to this message reds the equality.
      expect(body.error_description).toBe(`Caller scope "${star}" does not administer this subject`);
    });

    // Regression for the reject itself — the aud validation already 403s this, so the STATUS cannot
    // red an authorization mutation. But this is the ONE case where BOTH fail, which makes the error
    // CODE the only observable that pins the ORDER. Ordering is a load-bearing ADR-008 disclosure
    // decision (running the validation first tells a caller about to be refused where the subject
    // sits in the tree), so it needs to be capable of failing somewhere.
    // Mutation: swap `canMintFor` and the aud validation in worker-token.ts → `insufficient_scope` → reds.
    it('CROSS-UNIVERSE: a u1 admin cannot mint for a u2 subject — and ELIGIBILITY is what refuses it', async () => {
      const u1 = uni();
      const u2 = uni();
      const admin1 = await foundUniverse(SELF, u1, 'admin1@example.com');
      const admin2 = await foundUniverse(SELF, u2, 'admin2@example.com');

      const resp = await mintNarrowerRequest(SELF, admin1.access_token, { subOfNarrowerToken: admin2.parsed.sub, activeScope: u1 });
      expect(resp.status).toBe(403);
      expect((await resp.json() as any).error).toBe('forbidden'); // NOT insufficient_scope — order pin
    });

    // The WIDEST path — a bootstrap superuser at `nebula-platform`. That scope is the ROOT of the
    // tree and shares no prefix with any universe slug, so swapping `hasDominionOver` for a
    // prefix/equality compare reds this while leaving the cases above green. `activeScope` is PINNED
    // to the subject's own scope: an unrelated one would 403 on the aud validation and misdirect a
    // reader to eligibility.
    it('a bootstrap superuser CAN mint for a subject in an unrelated universe (200)', async () => {
      const u2 = uni();
      const subject = await foundUniverse(SELF, u2, 'other-admin@example.com');
      const platform = await platformLogin(SELF, BOOTSTRAP_EMAIL, u2);
      expect(platform.parsed.access.authScope).toBe('nebula-platform'); // fixture guard

      const resp = await mintNarrowerRequest(SELF, platform.access_token, { subOfNarrowerToken: subject.parsed.sub, activeScope: u2 });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
      expect(parsed.sub).toBe(subject.parsed.sub);
      expect(parsed.act.sub).toBe(platform.parsed.sub);
    });

    // 🔒 **The mint case with NO other backstop: a PLATFORM-scoped SUBJECT.**
    //
    // ⚠️ **`activeScope` is pinned to a NON-platform scope deliberately, and that is the whole
    // point of the test.** With `activeScope = 'nebula-platform'` all three mint checks collapse to
    // `myScope === targetScope`, so the case greens whether or not `isAtOrAbove` carries the
    // platform-root branch — which is precisely the mutation it exists to catch. Aiming it at `{u}`
    // instead forces the SUBJECT bound to answer `isAtOrAbove('nebula-platform', '{u}')`, which is
    // true ONLY through the root branch.
    //
    // Every other mint test reaches that bound on its EQUALITY arm, so replacing the predicate
    // there with `===` (or dropping the root branch) leaves the whole tree green without this.
    //
    // Two bootstrap emails are configured (`vitest.config.js`), which is what makes a platform
    // caller impersonating a *different* platform subject constructible at all — the self-narrow
    // guard refuses a caller and subject sharing one `sub`.
    it('a platform caller CAN mint for a PLATFORM-scoped subject, into a non-platform activeScope', async () => {
      const u = uni();
      await foundUniverse(SELF, u, 'universe-admin@example.com'); // the scope must exist to aim at
      const subject = await platformLogin(SELF, SECOND_BOOTSTRAP_EMAIL);
      const caller = await platformLogin(SELF, BOOTSTRAP_EMAIL, u);
      // Fixture guards: BOTH principals must really be at the reserved scope, or the root branch
      // is never the thing under test.
      expect(subject.parsed.access.authScope).toBe('nebula-platform');
      expect(caller.parsed.access.authScope).toBe('nebula-platform');
      expect(subject.parsed.sub).not.toBe(caller.parsed.sub);

      const resp = await mintNarrowerRequest(SELF, caller.access_token, { subOfNarrowerToken: subject.parsed.sub, activeScope: u });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
      expect(parsed.sub).toBe(subject.parsed.sub);
      expect(parsed.act.sub).toBe(caller.parsed.sub);
      expect(parsed.aud).toBe(u);
    });
  });

  // ── The `aud` VALIDATION ────────────────────────────────────────────────────────────────────────
  // The bound eligibility does NOT give you: the caller's dominion covers the whole galaxy, so a
  // galaxy-wide `activeScope` is not an escalation — but with `authScope` pinned to the subject's
  // scope, an `aud` outside it could only mint a token that verifies NOWHERE; this refuses it early,
  // with the pinned status and code. Mutation: delete the validation → the mint throws at
  // `buildNebulaJwtPayload`'s construction invariant and answers 500, not 403 → this reds.
  it('rejects an activeScope outside the SUBJECT\'s own dominion (403 insufficient_scope)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com'); // authScope `${u}`
    const galaxy = `${u}.app`;
    const star = `${galaxy}.tenant`;
    const subject = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
    expect(subject.parsed.access.authScope).toBe(star); // the subject's dominion is the star alone

    const resp = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: subject.parsed.sub, activeScope: galaxy });
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string; error_description: string };
    expect(body.error).toBe('insufficient_scope');
    expect(body.error_description).not.toContain(star); // ADR-008: never name the subject's scope
  });

  describe('scope-bounded / escalation guards', () => {
    it('rejects cookie-only auth — the mint requires a Bearer access token (401)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');
      const resp = await SELF.fetch(new Request(registryUrl('mint-narrower-token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${admin.refreshToken}` },
        body: JSON.stringify({ subOfNarrowerToken: user.parsed.sub, activeScope: u }),
      }));
      expect(resp.status).toBe(401);
    });

    it('the SCOPED route is gone — POST /auth/{u}/mint-narrower-token → 404', async () => {
      // The segment was vestigial (the handler never received it); the route is scope-less now.
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const resp = await SELF.fetch(new Request(url(u, 'mint-narrower-token'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subOfNarrowerToken: 'x', activeScope: u }),
      }));
      expect(resp.status).toBe(404);
    });

    // INVERTED 2026-08-18 (this test's old assertion — `access.authScope === childScope` — was the
    // named justification for the deleted `authScopeOverride`): the minted `authScope` is the
    // SUBJECT's membership scope, verbatim; the requested scope becomes ONLY the `aud`.
    it("binds the minted authScope to the SUBJECT's membership scope; the REQUESTED scope is only the aud", async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com'); // authScope `${u}`
      const galaxy = `${u}.crm`;
      // Subject: a member whose OWN scope is the galaxy — distinct from both the caller's `${u}`
      // and the narrower `aud` below, so each wrong binding reds a different assertion.
      const subject = await inviteIntoGalaxy(SELF, galaxy, admin.access_token, 'gal-user@example.com');
      expect(subject.parsed.access.authScope).toBe(galaxy); // fixture guard

      const aud = `${galaxy}.tenant`; // narrower than the subject's membership
      const resp = await mintNarrowerRequest(SELF, admin.access_token,
        { subOfNarrowerToken: subject.parsed.sub, activeScope: aud });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
      expect(parsed.aud).toBe(aud);
      expect(parsed.access.authScope).toBe(galaxy); // the SUBJECT's — not the caller's, not the aud
      expect(isAtOrAbove(parsed.access.authScope, aud)).toBe(true); // aud ⊆ subject, the theorem
    });

    // RENAMED 2026-08-18: the deleted caller bound used to refuse this on `activeScope`; it now
    // keeps refusing FOR A DIFFERENT REASON — eligibility, since the caller does not administer the
    // subject — and the fixture is rebuilt so THAT is unambiguous (the subject's scope, not the
    // requested one, is what the caller cannot reach).
    it('rejects a SUBJECT the caller does not administer (403) — a narrower caller cannot use the mint to exceed itself', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com'); // scope `${u}`

      // A galaxy-scoped admin token (`${u}.gal`) — its dominion does NOT cover the subject at `${u}`.
      const narrow = await createNebulaTestToken({
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        sub: admin.parsed.sub,
        instanceName: `${u}.gal`,
        activeScope: `${u}.gal`,
        scopeAdmin: true,
      })();

      const resp = await mintNarrowerRequest(SELF, narrow.access_token,
        { subOfNarrowerToken: user.parsed.sub, activeScope: `${u}.gal` });
      expect(resp.status).toBe(403);
      expect((await resp.json() as any).error).toBe('forbidden');
    });

    // ⚠️ KEPT, not retired, alongside the REAL-artifact twin below. They cover different things: this
    // one proves gate 1 refuses ANY act-bearing token — including shapes this endpoint cannot mint,
    // such as the platform-prepended actor a future `prependActor` will produce — while the twin
    // proves the endpoint cannot chain off its OWN output. It is also the only in-repo consumer of
    // `createNebulaTestToken`'s `actor` option, which mirrors the production claim shape.
    it('rejects an act-bearing caller token — root identity only (403)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      const actBearing = await createNebulaTestToken({
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        sub: admin.parsed.sub,
        instanceName: u,
        activeScope: u,
        scopeAdmin: true,
        // → act: { sub: user, profileId } — an already act-bearing token
        actor: { sub: user.parsed.sub, profileId: user.parsed.profileId },
      })();

      const resp = await mintNarrowerRequest(SELF, actBearing.access_token, { subOfNarrowerToken: user.parsed.sub, activeScope: u });
      expect(resp.status).toBe(403);
    });

    // The REAL artifact: re-present a token THIS endpoint minted. Mutation: delete gate 1 → a depth-2
    // chain mints → this reds.
    // **Principal P2** is load-bearing twice over: a non-admin subject's ABSENT `access.scopeAdmin` would
    // let gate 3 mask the deletion (403 either way), and the subject must be a third party to clear
    // the self-narrow rejection.
    it('rejects a token THIS endpoint minted — no chaining off its own output (403)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const star = `${u}.app.tenant`;
      const starAdmin = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
      const third = await inviteAndLogin(SELF, star, admin.access_token, 'third@example.com');

      const minted = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: starAdmin.parsed.sub, activeScope: star });
      expect(minted.status).toBe(200);
      const narrower = (await minted.json() as any).access_token;
      // Fixture guard: the minted token really does carry admin, so gate 3 cannot mask gate 1.
      const parsed = parseJwtUnsafe(narrower)!.payload as any;
      expect(parsed.access.scopeAdmin).toBe(true);
      expect(parsed.act.sub).toBe(admin.parsed.sub);

      const resp = await mintNarrowerRequest(SELF, narrower, { subOfNarrowerToken: third.parsed.sub, activeScope: star });
      expect(resp.status).toBe(403);
    });
  });

  // ── The claims describe TWO people ──────────────────────────────────────────────────────────────
  describe('the actor pair', () => {
    // Mutation: drop `profileId` from the actor spread → this reds.
    it('emits act.profileId = the CALLER\'s, while the top-level pair stays the SUBJECT\'s (P1)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      const resp = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: user.parsed.sub, activeScope: u });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;

      expect(parsed.act.profileId).toBe(admin.parsed.profileId);      // the ACTOR's
      expect(parsed.act.profileId).not.toBe(user.parsed.profileId);
      // The invariant top-level `sub` and top-level `profileId` ALWAYS describe the same person — the
      // `QuerySubscribers` roster and `#rosterFor` persist that pair and must need no change.
      // Mutation: stamp the caller's `profileId` top-level → this reds.
      expect(parsed.sub).toBe(user.parsed.sub);
      expect(parsed.profileId).toBe(user.parsed.profileId);
    });

    // ⚠️ **Rung 3, justified IN PLACE (ADR-009's "a surface no client can construct" carve-out).**
    // Every real identity is stamped with a `profileId` at `#mintIdentity` and `RefreshTokenKV
    // .profileId` is a required `string`, so NO rung-1 caller token can lack the claim — the
    // fixture is unreachable through real issuance. `NebulaJwtPayload.profileId` is nevertheless
    // optional at every layer, so the mint must handle its absence.
    // Mutation: make `actor.profileId` required → this reds.
    // ⚠️ NOT a valid mutation: emitting `profileId: undefined`. `signJwt` encodes with
    // `JSON.stringify`, which drops undefined-valued keys, so it is byte-identical on the wire — the
    // conditional `profileId` spread INSIDE `act` is unobservable at the JWT boundary. The
    // load-bearing half of that construct is the UNCONDITIONAL `act`, which the `toEqual` covers.
    it('an ABSENT caller profileId still mints — act: { sub } with no profileId key', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      const noProfile = await createNebulaTestToken({
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        sub: admin.parsed.sub,
        instanceName: u,
        activeScope: u,
        scopeAdmin: true, // ...and deliberately NO `profileId`
      })();

      const resp = await mintNarrowerRequest(SELF, noProfile.access_token, { subOfNarrowerToken: user.parsed.sub, activeScope: u });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
      // `act` itself must still be PRESENT — `!claims.act` (the Profile owner guard) keys on its
      // presence, so a conditional whole-`act` spread would silently defeat that guard.
      expect(parsed.act).toEqual({ sub: admin.parsed.sub });
      expect('profileId' in parsed.act).toBe(false);
    });
  });
});

// ── ADR-016 — a destructive action records the ACTING principal ───────────────────────────────────
// Under impersonation a `sub`-only record names the person acted UPON as the person who acted, which
// is worse than no record because it will be believed. All FOUR elements are asserted separately: a
// record of `{ sub, act: { sub } }` satisfies "names both" while omitting two of them, and nothing
// would red.
describe('scope deletion records the acting principal (ADR-016)', () => {
  let sink: any[] = [];
  beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
  afterEach(() => clearDebugSink());

  it('a scope deleted under a NARROWER token records sub + act + profileId + access', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const star = `${u}.app.tenant`;
    // **P2** — an ADMIN subject. `#computeDeletionPlan` gates on `hasDominionOver` against the
    // MINTED token's access, so a P1 (non-admin) token 403s before the record is ever written.
    const starAdmin = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);

    const minted = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: starAdmin.parsed.sub, activeScope: star });
    expect(minted.status).toBe(200);
    const narrower = (await minted.json() as any).access_token;

    // `target` is the subject's OWN star — so the minted exact-star pattern administers it, and
    // `#emailForSub(callerSub)` resolves for the fail-closed warning-integrity check.
    const resp = await SELF.fetch(new Request(registryUrl('delete-scope'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${narrower}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: star }),
    }));
    expect(resp.status).toBe(200);

    const record = sink.find((e) =>
      e.namespace === 'nebula-auth.Registry.executeScopeDeletion' && e.message === 'Scope deleted');
    expect(record).toBeDefined();

    // (1) The subject `sub` — the person acted upon. Mutation: drop `sub` from the record → reds.
    expect(record.data.actingToken.sub).toBe(starAdmin.parsed.sub);
    // (2) The complete `act` chain — WHO ACTUALLY DROVE IT. This is the element whose absence makes
    // the record affirmatively wrong. Mutation: drop `act` → reds.
    expect(record.data.actingToken.act).toEqual({
      sub: admin.parsed.sub, profileId: admin.parsed.profileId,
    });
    // (3) `profileId` — display-only, write-time-pinned, so a departed actor is nameable with no
    // registry hop. Mutation: drop `profileId` → reds.
    expect(record.data.actingToken.profileId).toBe(starAdmin.parsed.profileId);
    // (4) The `access` entry — what authority was ASSERTED. Immutable history; never read back as an
    // authz input (that would be ADR-013's stored scope-set). Mutation: drop `access` → reds.
    expect(record.data.actingToken.access).toEqual({ authScope: star, scopeAdmin: true });
  });
});
