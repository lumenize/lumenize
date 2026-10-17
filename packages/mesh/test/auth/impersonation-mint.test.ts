/**
 * The impersonation mint — `mintImpersonationToken`, the function `AuthFacade.impersonate`
 * calls. The authorize line (root identity ∧ different sub ∧ accepted subject ∧ `canMintFor`), the
 * mirror mint, the `aud` validation and its order (security.md § Delegation, mint-side) are the
 * load-bearing cases.
 *
 * Driven as the function, with the claims of real logins' verified tokens: this lane holds no
 * Gateway to reach the facade through, and the facade adds only the typed refusal, which
 * `apps/nebula`'s baseline lane drives. The child's `aud` is the CALLER's, so a test that needs the
 * child on a particular page refreshes the caller's session onto that page first ({@link onPage}).
 *
 * The cross-scope tests mint caller tokens via `createTestToken` (ADR-009 rung 3, justified —
 * a same-scope fixture cannot tell "bind to the caller's scope" from "bind to the subject's").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import {
  foundUniverse, inviteAndLogin, foundStarAndLogin, inviteIntoGalaxy, platformLogin,
  BOOTSTRAP_EMAIL, SECOND_BOOTSTRAP_EMAIL, issueInvitesAs, clickLink, acceptMembership,
  refreshAndParse, verifiedClaims, registryStub,
  TEST_ISSUER,
} from './test-helpers';
import { createTestToken } from '../../src/auth/create-test-token';
import { mintImpersonationToken, type ImpersonationMint } from '../../src/auth/worker-token';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

/** Mint as the holder of `callerToken`, for `sub`. */
async function mint(callerToken: string, sub: string, ttlSeconds?: number): Promise<ImpersonationMint> {
  return mintImpersonationToken(env as Env, await verifiedClaims(callerToken), sub, ttlSeconds);
}

/** The minted token's payload; fails the test on a refusal, naming it. */
function payloadOf(minted: ImpersonationMint): any {
  if (!minted.ok) throw new Error(`refused: ${minted.message}`);
  return parseJwtUnsafe(minted.accessToken)!.payload;
}

/** The refusal's message; fails the test on a mint. */
function refusalOf(minted: ImpersonationMint): string {
  expect(minted.ok, 'expected a refusal').toBe(false);
  return (minted as { message: string }).message;
}

/** The caller's session, refreshed onto `aud` — the page the child will act on. */
async function onPage(caller: { refreshToken: string; parsed: { access: { authScope: string } } }, aud: string) {
  return (await refreshAndParse(SELF, caller.parsed.access.authScope, caller.refreshToken, aud)).access_token;
}

describe('the impersonation mint', () => {
  // ── FAITHFULNESS, the `admin` mirror ────────────────────────────────────────────────────────────
  // The caller's bit is what made a token act with admin-derived dominion the subject may not have,
  // so `org-tree.ts`'s scope-admin bypass fired and the denial an admin came to observe never
  // happened. Mutation: mint the caller's `scopeAdmin` instead of the subject's → this reds.
  it('an admin mints for a member — sub=subject, act.sub=caller, admin bit MIRRORS the subject (P1)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com'); // non-admin member

    const parsed = payloadOf(await mint(admin.access_token, user.parsed.sub));
    expect(parsed.sub).toBe(user.parsed.sub);       // the subject
    expect(parsed.act.sub).toBe(admin.parsed.sub);  // the real actor
    expect(parsed.aud).toBe(u);                     // the caller's own page
    // `user` is `scopeAdmin=0`, so the mirror leaves the bit ABSENT (it is omitted, never `false`).
    expect(parsed.access.scopeAdmin).toBeUndefined();
  });

  // The P2 twin — the same mirror, with a subject who really IS an admin. Without this, an
  // implementation that hard-codes `scopeAdmin: false` would pass the test above.
  it('...and MIRRORS a TRUE bit for an admin subject — a `claimStar` star-scoped admin (P2)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    const star = `${u}.app.tenant`;
    const starAdmin = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
    expect(starAdmin.parsed.access.scopeAdmin).toBe(true); // fixture guard — else the assertion below is vacuous

    const parsed = payloadOf(await mint(await onPage(admin, star), starAdmin.parsed.sub));
    expect(parsed.sub).toBe(starAdmin.parsed.sub);
    expect(parsed.access.scopeAdmin).toBe(true);
    expect(parsed.access.authScope).toBe(star); // exact-star — the SUBJECT's own membership scope
  });

  // ── SELF-NARROWING is rejected ──────────────────────────────────────────────────────────────────
  // Mutation: delete the check → a token with `act.sub === sub` mints → this reds.
  it('rejects SELF-narrowing — an admin minting for their OWN sub', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    expect(refusalOf(await mint(admin.access_token, admin.parsed.sub))).toMatch(/different sub/);
  });

  it('a non-admin caller cannot mint — the authorized-actor path is gone', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    const scope = `${u}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    const other = await inviteAndLogin(SELF, scope, admin.access_token, 'other@example.com');

    expect(refusalOf(await mint(member.access_token, other.parsed.sub)))
      .toBe(`The calling host's scope "${scope}" does not administer this subject`);
  });

  // ── Refusal and absence are INDISTINGUISHABLE ───────────────────────────────────────────────────
  // The subject lookup precedes authorization, so a distinct not-found answer would make the mint a
  // `sub`-existence oracle for any authenticated caller. Reds against any refusal that varies with
  // whether the subject exists.
  it('a caller without dominion cannot tell a real subject from an absent one — same refusal', async () => {
    const u1 = uni();
    const u2 = uni();
    const admin1 = await foundUniverse(SELF, u1, 'admin1@example.com');
    const admin2 = await foundUniverse(SELF, u2, 'admin2@example.com'); // real, but not admin1's to act for

    const absent = refusalOf(await mint(admin1.access_token, 'no-such-sub'));
    const realButRefused = refusalOf(await mint(admin1.access_token, admin2.parsed.sub));
    expect(absent).toBe(realButRefused);
  });

  // ── ACCEPTANCE, enforced at the mint ────────────────────────────────────────────────────────────
  // An invite mints the membership immediately and un-taken-up, so without this a bad actor mints a
  // token carrying a stranger's `profileId`: claim a Universe, invite an address you guessed,
  // impersonate them. ADR-012 § *Alternatives considered* carries that story and why the refusal
  // belongs here rather than at the Profile's owner branch; `security.md` rule (2) states the rule.
  //
  // ⚠️ **The FIXTURE is the discriminator, not the message.** The refusal below is the collapsed one
  // this file already asserts equal above — deliberately, so a dominion holder learns nothing new
  // about who exists. What makes it mean *unaccepted* is that the caller holds dominion over the
  // very scope the membership sits in, so the other readings of that refusal are excluded by
  // construction.
  //
  // ⚠️ **No fixture in `apps/nebula` can build this** — `createSubject` and `createInvitedClient` both
  // accept on the way through, so the unaccepted arm exists only here, where the ladder's rungs
  // (`issueInvitesAs` / `clickLink` / `acceptMembership`) are separate steps.
  //
  // Mutation: drop `AND m.acceptedAt IS NOT NULL` from the registry's `getIdentityScope` → the first
  // arm mints → reds. Skip the `acceptMembership` call → the second arm refuses → reds.
  it('refuses a subject who never ACCEPTED, and mints for the same subject once they do', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);

    const invited = await issueInvitesAs(admin.access_token, u, [{ email: 'pending@example.com' }]);
    expect(invited.errors).toHaveLength(0);
    const subject = invited.results[0]!.sub;

    expect(refusalOf(await mint(admin.access_token, subject)))
      .toBe(`The calling host's scope "${u}" does not administer this subject`);

    // Take the membership up the way its holder does. The click places the path-scoped cookie and is
    // NOT acceptance — mail scanners click links — so both steps are load-bearing.
    const { refreshToken } = await clickLink(SELF, invited.results[0]!.inviteUrl);
    await acceptMembership(SELF, u, refreshToken);

    // The positive control: same caller, same subject. Without it the arm above stays green against
    // a mint that refuses everyone.
    const parsed = payloadOf(await mint(admin.access_token, subject));
    expect(parsed.sub).toBe(subject);
    expect(parsed.act.sub).toBe(admin.parsed.sub);
  });

  // ── (1) ELIGIBILITY ─────────────────────────────────────────────────────────────────────────────
  describe('eligibility — you may only impersonate someone you already administer entirely', () => {
    // THE case eligibility uniquely rejects: UPWARD. A star-tier admin wearing a galaxy-tier
    // identity. The aud validation (`isAtOrAbove('u.g', 'u.g.s')`) holds, so ONLY `canMintFor` can
    // produce this refusal — and only this stops a lower admin wearing a superior's identity.
    // Mutation: make `canMintFor` reflexively true (the caller's own scope as the second argument) →
    // the mint succeeds → this reds. That is the substitution the named wrapper exists to foreclose.
    it('UPWARD: a star-tier admin cannot mint for a galaxy-tier subject', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const galaxy = `${u}.app`;
      const star = `${galaxy}.tenant`;

      const caller = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
      expect(caller.parsed.access.authScope).toBe(star); // fixture guard: an exact-star scope
      // Subject: a member whose OWN scope is the parent galaxy — strictly above the caller.
      const subject = await inviteIntoGalaxy(SELF, galaxy, admin.access_token, 'gal-member@example.com');

      // ADR-008: the refusal must not disclose where the subject sits in the tree. Asserted as an
      // EXACT echo of the caller's own scope rather than `not.toContain(galaxy)` — in the upward
      // case the subject's scope is by construction an ancestor path of the caller's own, so a
      // substring check can never distinguish "leaked it" from "echoed what the caller holds".
      expect(refusalOf(await mint(caller.access_token, subject.parsed.sub)))
        .toBe(`The calling host's scope "${star}" does not administer this subject`);
    });

    // The ONE case where BOTH checks fail, which makes the message the only observable that pins the
    // ORDER. Ordering is a load-bearing ADR-008 disclosure decision (running the validation first
    // tells a caller about to be refused where the subject sits in the tree).
    // Mutation: swap `canMintFor` and the aud validation in worker-token.ts → the page message → reds.
    it('CROSS-UNIVERSE: a u1 admin cannot mint for a u2 subject — and ELIGIBILITY is what refuses it', async () => {
      const u1 = uni();
      const u2 = uni();
      const admin1 = await foundUniverse(SELF, u1, 'admin1@example.com');
      const admin2 = await foundUniverse(SELF, u2, 'admin2@example.com');

      expect(refusalOf(await mint(admin1.access_token, admin2.parsed.sub)))
        .toBe(`The calling host's scope "${u1}" does not administer this subject`);
    });

    // The WIDEST path — a bootstrap superuser at `_platform`. That scope is the ROOT of the tree and
    // shares no prefix with any universe slug, so swapping `hasDominionOver` for a prefix/equality
    // compare reds this while leaving the cases above green. The caller's page is the subject's own
    // universe: an unrelated one would fail the aud validation and misdirect a reader to eligibility.
    it('a bootstrap superuser CAN mint for a subject in an unrelated universe', async () => {
      const u2 = uni();
      const subject = await foundUniverse(SELF, u2, 'other-admin@example.com');
      const platform = await platformLogin(SELF, BOOTSTRAP_EMAIL, u2);
      expect(platform.parsed.access.authScope).toBe('_platform'); // fixture guard

      const parsed = payloadOf(await mint(platform.access_token, subject.parsed.sub));
      expect(parsed.sub).toBe(subject.parsed.sub);
      expect(parsed.act.sub).toBe(platform.parsed.sub);
    });

    // The platform scope is the ROOT of the tree, so no non-platform caller's scope can sit at or
    // above it, and `canMintFor` refuses without any special arm. What this catches is a special arm
    // being ADDED — mutation: `|| isPlatformScope(subject.universeGalaxyStarId)` inside canMintFor
    // greens every other test and reds this one.
    it('a _platform subject is UN-IMPERSONABLE by a non-platform caller (collapsed refusal)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const platformSubject = await platformLogin(SELF, SECOND_BOOTSTRAP_EMAIL);
      expect(platformSubject.parsed.access.authScope).toBe('_platform'); // fixture guard

      // The collapsed refusal — and per ADR-008 it must not disclose the subject's scope.
      expect(refusalOf(await mint(admin.access_token, platformSubject.parsed.sub)))
        .toBe(`The calling host's scope "${u}" does not administer this subject`);
    });

    it('a platform caller CANNOT mint for another PLATFORM-scoped subject: no host reaches the root', async () => {
      // Dominion reads the calling host's scope (the host rule), and the platform root is no host's,
      // so a superuser on `{u}`'s host holds dominion over `{u}`'s subtree and not over a subject
      // whose membership is the root. Two bootstrap emails (`vitest.config.js`) make the pair
      // constructible at all.
      const u = uni();
      await foundUniverse(SELF, u, 'universe-admin@example.com'); // the scope must exist to aim at
      const subject = await platformLogin(SELF, SECOND_BOOTSTRAP_EMAIL);
      const caller = await platformLogin(SELF, BOOTSTRAP_EMAIL, u);
      expect(subject.parsed.access.authScope).toBe('_platform');
      expect(caller.parsed.access.authScope).toBe('_platform');
      expect(subject.parsed.sub).not.toBe(caller.parsed.sub);

      expect(refusalOf(await mint(caller.access_token, subject.parsed.sub)))
        .toBe(`The calling host's scope "${u}" does not administer this subject`);
    });
  });

  // ── The `aud` VALIDATION ────────────────────────────────────────────────────────────────────────
  // The bound eligibility does NOT give you: the caller's dominion covers the whole galaxy, so a
  // galaxy page is not an escalation — but with `authScope` pinned to the subject's scope, an `aud`
  // outside it could only mint a token that verifies NOWHERE, so this refuses it early. Mutation:
  // delete the validation → the mint throws at `buildAuthClaims`'s construction invariant
  // rather than answering this refusal → reds.
  it('refuses a caller whose page is outside the SUBJECT\'s own scope, naming only the page', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    const galaxy = `${u}.app`;
    const star = `${galaxy}.tenant`;
    const subject = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
    expect(subject.parsed.access.authScope).toBe(star); // the subject's scope is the star alone

    expect(refusalOf(await mint(await onPage(admin, galaxy), subject.parsed.sub)))
      .toBe(`This page's scope "${galaxy}" is outside the subject's own scope`);
  });

  describe('scope-bounded / escalation guards', () => {
    // The minted `authScope` is the SUBJECT's membership scope, verbatim; the caller's host becomes
    // ONLY the `aud`, and under the host rule that host is the subject's own scope.
    it("binds the minted authScope to the SUBJECT's membership scope; the caller's host is only the aud", async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const galaxy = `${u}.crm`;
      // Subject: a plain member whose OWN scope is the galaxy — distinct from the caller's `${u}`,
      // so a binding to the caller's membership reds.
      const subject = await inviteIntoGalaxy(SELF, galaxy, admin.access_token, 'gal-user@example.com');
      expect(subject.parsed.access.authScope).toBe(galaxy); // fixture guard

      const parsed = payloadOf(await mint(await onPage(admin, galaxy), subject.parsed.sub));
      expect(parsed.aud).toBe(galaxy);
      expect(parsed.access.authScope).toBe(galaxy); // the SUBJECT's — not the caller's `${u}`
      expect(parsed.access.scopeAdmin).toBeUndefined(); // the subject's plain membership
    });

    // The host rule's half: the caller's dominion reads its host, so the same universe admin on a
    // tenant's page holds none over the galaxy above it, and is refused before any validation.
    it("refuses a caller whose host sits below the subject's scope, naming that host", async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const galaxy = `${u}.crm`;
      const subject = await inviteIntoGalaxy(SELF, galaxy, admin.access_token, 'gal-user2@example.com');
      const page = `${galaxy}.tenant`;
      expect(refusalOf(await mint(await onPage(admin, page), subject.parsed.sub)))
        .toBe(`The calling host's scope "${page}" does not administer this subject`);
    });

    it('refuses a SUBJECT the caller does not administer — a narrower caller cannot use the mint to exceed itself', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com'); // scope `${u}`

      // A galaxy-scoped admin token (`${u}.gal`) — its dominion does NOT cover the subject at `${u}`.
      const narrow = await createTestToken({
        issuer: TEST_ISSUER,
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        sub: admin.parsed.sub,
        instanceName: `${u}.gal`,
        activeScope: `${u}.gal`,
        scopeAdmin: true,
        profileId: admin.parsed.profileId,
      })();

      expect(refusalOf(await mint(narrow.access_token, user.parsed.sub)))
        .toBe(`The calling host's scope "${u}.gal" does not administer this subject`);
    });

    // ⚠️ KEPT alongside the REAL-artifact twin below. They cover different things: this one proves
    // the root-identity gate refuses ANY act-bearing token — including shapes this mint cannot
    // produce — while the twin proves the mint cannot chain off its OWN output.
    it('rejects an act-bearing caller token — root identity only', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      const actBearing = await createTestToken({
        issuer: TEST_ISSUER,
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        sub: admin.parsed.sub,
        instanceName: u,
        activeScope: u,
        scopeAdmin: true,
        profileId: admin.parsed.profileId,
        actor: { sub: user.parsed.sub, profileId: user.parsed.profileId },
      })();

      expect(refusalOf(await mint(actBearing.access_token, user.parsed.sub))).toMatch(/root identity/);
    });

    // The REAL artifact: re-present a token THIS mint produced. Mutation: delete the root-identity
    // gate → a depth-2 chain mints → this reds. **Principal P2** is load-bearing: a non-admin
    // subject's ABSENT bit would let eligibility mask the deletion, and the subject must be a third
    // party to clear the self-narrow rejection.
    it('rejects a token THIS mint produced — no chaining off its own output', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const star = `${u}.app.tenant`;
      const starAdmin = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
      const third = await inviteAndLogin(SELF, star, admin.access_token, 'third@example.com');

      const minted = await mint(await onPage(admin, star), starAdmin.parsed.sub);
      const parsed = payloadOf(minted);
      // Fixture guard: the minted token really does carry admin, so eligibility cannot mask the gate.
      expect(parsed.access.scopeAdmin).toBe(true);
      expect(parsed.act.sub).toBe(admin.parsed.sub);

      expect(refusalOf(await mint((minted as { accessToken: string }).accessToken, third.parsed.sub)))
        .toMatch(/root identity/);
    });
  });

  // ── The claims describe TWO people ──────────────────────────────────────────────────────────────
  describe('the actor pair', () => {
    // Mutation: drop `profileId` from the actor → this reds.
    it('emits act.profileId = the CALLER\'s, while the top-level pair stays the SUBJECT\'s (P1)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      const parsed = payloadOf(await mint(admin.access_token, user.parsed.sub));
      expect(parsed.act.profileId).toBe(admin.parsed.profileId);      // the ACTOR's
      expect(parsed.act.profileId).not.toBe(user.parsed.profileId);
      // Top-level `sub` and top-level `profileId` ALWAYS describe the same person. Mutation: stamp
      // the caller's `profileId` top-level → this reds.
      expect(parsed.sub).toBe(user.parsed.sub);
      expect(parsed.profileId).toBe(user.parsed.profileId);
    });
  });
});

// ── ADR-016 — what the mint and a deletion under its token record ─────────────────────────────────
// Under impersonation a `sub`-only record names the person acted UPON as the person who acted, which
// is worse than no record because it will be believed. Each element is asserted separately.
describe('the acting principal is recorded (ADR-016)', () => {
  let sink: any[] = [];
  beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
  afterEach(() => clearDebugSink());

  // Mutation: record only the subject → `actingToken` is absent → reds.
  it('the mint records the subject beside the caller\'s whole projected claims, page included', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');
    payloadOf(await mint(admin.access_token, user.parsed.sub));

    const record = sink.find((e) => e.namespace === 'nebula-auth.facade.impersonate');
    expect(record?.data.subOfNarrowerToken).toBe(user.parsed.sub);
    expect(record?.data.actingToken).toEqual({
      sub: admin.parsed.sub, profileId: admin.parsed.profileId,
      access: { authScope: u, scopeAdmin: true }, aud: u,
    });
  });

  it('a scope deleted under an impersonation token records sub + act + profileId + access + aud', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    const star = `${u}.app.tenant`;
    // **P2** — an ADMIN subject. `#computeDeletionPlan` gates on `hasDominionOver` against the
    // MINTED token's access, so a P1 (non-admin) token is refused before the record is written.
    const starAdmin = await foundStarAndLogin(SELF, star, 'scope-admin@example.com', admin.access_token);
    const minted = await mint(await onPage(admin, star), starAdmin.parsed.sub);
    payloadOf(minted);

    // `target` is the subject's OWN star — so the minted exact-star scope administers it, and the
    // subject's `sub` resolves for the fail-closed warning-integrity check.
    await registryStub().executeScopeDeletion(star, await verifiedClaims((minted as { accessToken: string }).accessToken));

    const record = sink.find((e) =>
      e.namespace === 'nebula-auth.Registry.executeScopeDeletion' && e.message === 'Scope deleted');
    expect(record).toBeDefined();
    // (1) The subject `sub` — the person acted upon.
    expect(record.data.actingToken.sub).toBe(starAdmin.parsed.sub);
    // (2) The complete `act` chain — WHO ACTUALLY DROVE IT, the element whose absence makes the
    // record affirmatively wrong.
    expect(record.data.actingToken.act).toEqual({
      sub: admin.parsed.sub, profileId: admin.parsed.profileId,
    });
    // (3) `profileId` — display-only, write-time-pinned.
    expect(record.data.actingToken.profileId).toBe(starAdmin.parsed.profileId);
    // (4) The `access` entry — what authority was ASSERTED. Never read back as an authz input.
    expect(record.data.actingToken.access).toEqual({ authScope: star, scopeAdmin: true });
    // (5) The page the token was minted for. Mutation: drop `aud` from the projection → reds.
    expect(record.data.actingToken.aud).toBe(star);
  });
});
