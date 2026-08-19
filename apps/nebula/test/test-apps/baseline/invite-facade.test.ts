/**
 * The invite facade — the mesh-speaking guarded entry (`NebulaAuthFacade.invite`, reached by a
 * client `lmz.callAsync('NEBULA_AUTH_FACADE', undefined, …)` through the Gateway; a service
 * binding with no instance name routes as a LumenizeWorker).
 *
 * The rule under test, enforced once, at this facade:
 *   eligibility = exact-scope membership ∨ dominion over the target scope;
 *   the minted bit never exceeds the inviter's dominion verdict.
 *
 * ADR-009 rung 2 throughout (the whole baseline lane): real founding, real invites, real
 * server-issued logins; test-mode `links` only as the URL carrier, with every persisted-bit
 * assertion made on a real-login JWT, never the invite summary alone. Every test here ALSO proves
 * the § *One Registry primitive* verify-anyway: a client `lmz` call reaches a WORKER binding
 * through the Gateway — nothing in this file talks HTTP to `/invite`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { hasDominionOver, type InviteSummary, type NebulaJwtPayload } from '@lumenize/nebula-auth';
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import type { NebulaClient } from '@lumenize/nebula';
import { NebulaClientTest } from './index';
import {
  universeAdminClient, adminClientAt, createInvitedClient, createSubject, createPlatformAdminClient,
  browserLogin, pointAtOrigin, refreshToken, uniqueStar, universeOf,
} from '../../test-helpers';

function em(tag: string): string { return `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`; }

/** Drive the facade the way production does: client → Gateway → Worker binding. */
function facadeInvite(
  client: NebulaClient, targetScope: string, invitees: unknown,
): Promise<InviteSummary> {
  return client.lmz.callAsync(
    'NEBULA_AUTH_FACADE', undefined,
    client.ctn<NebulaAuthFacade>().invite(targetScope, invitees as any),
  );
}

/** Accept a facade-minted invite link (re-pointed at this lane's origin) and refresh at `scope` —
 *  the real-login path every persisted-bit assertion rides (ADR-009). The refresh succeeding IS
 *  the click assertion: without the cookie the click sets, it answers 401. */
async function acceptInvite(link: string, scope: string): Promise<NebulaJwtPayload> {
  const browser = new Browser();
  await browser.fetch(pointAtOrigin(link));
  const { payload } = await refreshToken(browser, scope, scope);
  return payload;
}

describe('invite facade — eligibility and the cap', () => {
  it('a NON-admin member invites a peer into exactly their own scope — and the peer request caps to 0', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    const { accessToken: adminToken } = await universeAdminClient(NebulaClientTest, browser, star, star, em('adm'));
    const memberEmail = em('member');
    await createSubject(browser, star, adminToken, memberEmail);
    const { client: member, payload: memberPayload } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, memberEmail,
    );
    // Fixture guard: the inviter really is a non-admin whose own scope IS the target.
    expect(memberPayload.access.scopeAdmin).toBeUndefined();
    expect(memberPayload.access.authScope).toBe(star);

    try {
      // Limb 1: the peer invite SUCCEEDS — refusing this caller re-enforces the retired admin-only
      // model (mutation: re-add a dominion requirement to the facade → this reds).
      const peerEmail = em('peer');
      const summary = await facadeInvite(member, star, [{ email: peerEmail, scopeAdmin: true }]);
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0].outcome).toBe('invited');

      // Limb 2: HOWEVER the request asks, a peer inviter's bit caps to 0 — asserted on the
      // invitee's real-login JWT (mutation: honor the requested bit without the verdict → reds).
      const peerPayload = await acceptInvite(summary.links![peerEmail]!, star);
      expect(peerPayload.access.authScope).toBe(star);
      expect(peerPayload.access.scopeAdmin).toBeUndefined();
    } finally {
      member.disconnect();
    }
  });

  it('the caller-received summary carries per-invitee results and NOTHING the sender needs (no URL fields)', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    const { client: admin } = await universeAdminClient(NebulaClientTest, browser, star, star, em('adm'));
    try {
      const invitee = em('strip');
      const wrongTyped = em('wrongtyped');
      const summary = await facadeInvite(admin, star, [
        { email: invitee },
        // The ADR-001 boundary is THIS method now, and the facade re-emits the literal bit — so a
        // wrong-typed `"false"` must never mint an admin even under a DOMINION caller, where the
        // registry's own `=== true` re-check cannot save it (the facade would have re-emitted
        // `true`). Reds against relaxing the facade's `=== true` to truthiness.
        { email: wrongTyped, scopeAdmin: 'false' },
      ]);
      // Test mode's `links` map is the ONE carrier of the URL; the per-invitee results are the
      // projected summary rows exactly — no `inviteUrl`, no `accepted`. Reds against passing the
      // mint result through unfiltered (which would add both keys to every row).
      expect(summary.links![invitee]).toContain('accept-invite');
      expect(Object.keys(summary.results[0]).sort()).toEqual(['email', 'outcome', 'sub']);
      const wrongTypedPayload = await acceptInvite(summary.links![wrongTyped]!, star);
      expect(wrongTypedPayload.access.scopeAdmin).toBeUndefined();
    } finally {
      admin.disconnect();
    }
  });
});

describe('createSubject drives the mesh invite', () => {
  it('wires the scopeAdmin option through to the minted membership', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    const { accessToken: adminToken } = await universeAdminClient(NebulaClientTest, browser, star, star, em('adm'));
    const adminee = em('made-admin');
    // The option rides the per-invitee entry through client.invite → facade → registry — reds
    // against dropping it from the forwarded entry (the invitee would mint as a plain member).
    await createSubject(new Browser(), star, adminToken, adminee, { scopeAdmin: true });
    const { payload } = await browserLogin(new Browser(), star, adminee);
    expect(payload.access.scopeAdmin).toBe(true);
    expect(payload.access.authScope).toBe(star);
  });
});

describe('invite facade — negatives, message-asserted and distinguishable', () => {
  it('(a) neither membership nor dominion; (b) an admin whose scope does not cover a sibling — different messages', async () => {
    const star = uniqueStar();
    const universe = universeOf(star);
    const browser = new Browser();
    const { accessToken: adminToken } = await universeAdminClient(NebulaClientTest, browser, star, star, em('adm'));
    const memberEmail = em('member');
    await createSubject(browser, star, adminToken, memberEmail);
    const { client: member, payload: memberPayload } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, memberEmail,
    );

    // A real star-scoped ADMIN for limb (b): their scopeAdmin is true, but a sibling galaxy sits
    // outside their scope. (universeAdminClient's identity would pass — its scope covers
    // everything beneath the universe — so the admin limb needs an admin BELOW the sibling.)
    // Their own fresh universe: `foundStarAndLogin` provisions universe + galaxy + star under ONE
    // email, so it cannot ride a universe someone else's email already founded.
    const adminStar = uniqueStar();
    const { client: starAdmin, payload: starAdminPayload } =
      await adminClientAt(NebulaClientTest, new Browser(), adminStar, adminStar, em('staradm'));
    expect(starAdminPayload.access.scopeAdmin).toBe(true);
    expect(starAdminPayload.access.authScope).toBe(adminStar);

    try {
      // (a) A plain member of `star` inviting into the UNIVERSE above: upward passage is free but
      // this caller has neither exact membership there nor dominion — the forbidden shape is
      // unrepresentable. Message names the membership rule.
      await expect(facadeInvite(member, universe, [{ email: em('x') }]))
        .rejects.toThrow(`Token scope "${star}" is not a membership at "${universe}" and holds no scopeAdmin over it`);

      // (b) An ADMIN whose scope does not cover the target (a sibling galaxy): the dominion rule
      // fails, and the message says so — distinguishable from (a) (mutation: collapse the two
      // refusals into one message → both limbs red).
      const siblingGalaxy = `${universeOf(adminStar)}.other`;
      await expect(facadeInvite(starAdmin, siblingGalaxy, [{ email: em('x') }]))
        .rejects.toThrow(`Token scope "${adminStar}" does not administer "${siblingGalaxy}"`);
    } finally {
      member.disconnect();
      starAdmin.disconnect();
    }
  });

  it('absent claims fail closed with their own message, distinguishable from the wrong-scope refusals', async () => {
    // A direct entrypoint RPC carries no mesh envelope, so the facade sees exactly the
    // claims-less callContext a `newChain` continuation produces (the Gateway always stamps
    // originAuth on CLIENT calls, so a client cannot construct this shape — a server-side fresh
    // origin can). Mutation: default absent claims to an empty-but-truthy access object → reds.
    await expect(
      (env as any).NEBULA_AUTH_FACADE.invite(uniqueStar(), [{ email: em('x') }]),
    ).rejects.toThrow('Invite requires a verified identity');
  });

  it('a malformed entry is a per-invitee error in a RESOLVED summary — the batch never fails whole', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    const { client: admin } = await universeAdminClient(NebulaClientTest, browser, star, star, em('adm'));
    try {
      // Distinguishable by SHAPE from the registry's past-the-facade in-method cap throw, which
      // REJECTS the whole call (asserted in nebula-auth's own suite): here the promise resolves
      // and the malformed entry rides the per-invitee error list.
      const good = em('good');
      const summary = await facadeInvite(admin, star, [{ email: good }, { email: 'not-an-email' }, 42]);
      expect(summary.results.map(r => r.email)).toEqual([good]);
      expect(summary.errors).toHaveLength(2);
      expect(summary.errors[0].error).toBe('Invalid email format');

      // And a malformed targetScope is an expected client error with its own message.
      await expect(facadeInvite(admin, 'not..a..scope', [{ email: em('x') }]))
        .rejects.toThrow(/Invalid invite target/);
    } finally {
      admin.disconnect();
    }
  });
});

describe('invite facade — tier coverage (membership at the named scope + the observed verdict)', () => {
  it('star-, galaxy-, universe-, and platform-tier invites each land, with exactly the dominion the rule says', async () => {
    const star = uniqueStar();
    const universe = universeOf(star);
    const galaxy = star.split('.').slice(0, 2).join('.');
    const browser = new Browser();
    const { client: admin } = await universeAdminClient(NebulaClientTest, browser, star, star, em('adm'));

    try {
      // ── STAR tier, with the bit under dominion ────────────────────────────────────────────────
      const starAdminEmail = em('tier-star');
      const starSummary = await facadeInvite(admin, star, [{ email: starAdminEmail, scopeAdmin: true }]);
      const starPayload = await acceptInvite(starSummary.links![starAdminEmail]!, star);
      expect(starPayload.access.authScope).toBe(star);
      // The observed verdict, never a pattern string: dominion at their own star, none above.
      expect(hasDominionOver(starPayload.access, star)).toBe(true);
      expect(hasDominionOver(starPayload.access, galaxy)).toBe(false);

      // ── GALAXY tier — load-bearing twice: no claim path can authenticate at a 2-segment scope,
      // so this invite is the sole production mint there, AND the accept-invite login happens AT
      // the 2-segment scope — a principal never producible before this task. ──────────────────────
      const galaxyAdminEmail = em('tier-galaxy');
      const galaxySummary = await facadeInvite(admin, galaxy, [{ email: galaxyAdminEmail, scopeAdmin: true }]);
      const galaxyPayload = await acceptInvite(galaxySummary.links![galaxyAdminEmail]!, galaxy);
      expect(galaxyPayload.access.authScope).toBe(galaxy);
      expect(hasDominionOver(galaxyPayload.access, galaxy)).toBe(true);
      expect(hasDominionOver(galaxyPayload.access, star)).toBe(true);      // downward, whole rule
      expect(hasDominionOver(galaxyPayload.access, universe)).toBe(false); // upward is nil

      // ── UNIVERSE tier ────────────────────────────────────────────────────────────────────────
      const uniAdminEmail = em('tier-universe');
      const uniSummary = await facadeInvite(admin, universe, [{ email: uniAdminEmail, scopeAdmin: true }]);
      const uniPayload = await acceptInvite(uniSummary.links![uniAdminEmail]!, universe);
      expect(uniPayload.access.authScope).toBe(universe);
      expect(hasDominionOver(uniPayload.access, galaxy)).toBe(true);
      expect(hasDominionOver(uniPayload.access, 'nebula-platform')).toBe(false);

      // ── PLATFORM tier — a platform-dominion holder invites into the root scope ───────────────
      const platformBrowser = new Browser();
      // activeScope = the universe (the established caller shape); the TARGET rides the facade
      // argument, so inviting into the root scope needs no session AT it — only dominion.
      const { client: platformAdmin } = await createPlatformAdminClient(
        NebulaClientTest, platformBrowser, universe,
      );
      try {
        const platformInvitee = em('tier-platform');
        const pSummary = await facadeInvite(platformAdmin, 'nebula-platform', [{ email: platformInvitee, scopeAdmin: true }]);
        const pPayload = await acceptInvite(pSummary.links![platformInvitee]!, 'nebula-platform');
        expect(pPayload.access.authScope).toBe('nebula-platform');
        // The reserved platform scope is the ROOT of the tree: dominion over everything.
        expect(hasDominionOver(pPayload.access, universe)).toBe(true);
        expect(hasDominionOver(pPayload.access, star)).toBe(true);
      } finally {
        platformAdmin.disconnect();
      }
    } finally {
      admin.disconnect();
    }
  });
});

describe('invite facade — ADR-016 records survive the reshape', () => {
  const sink: any[] = [];
  beforeEach(() => { sink.length = 0; setDebugSink((e) => sink.push(e)); });
  afterEach(() => { clearDebugSink(); });

  it('an invite under an IMPERSONATION token records the real act chain end-to-end', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    const { client: admin, payload: adminPayload, accessToken: adminToken } =
      await universeAdminClient(NebulaClientTest, browser, star, star, em('adm'));
    const memberEmail = em('member');
    await createSubject(browser, star, adminToken, memberEmail);
    const invited = await createInvitedClient(NebulaClientTest, new Browser(), star, star, memberEmail);
    const memberSub = invited.payload.sub;
    invited.client.disconnect();

    // The admin impersonates the member; the CHILD (a plain member at exactly `star`, carrying a
    // real `act` chain) peer-invites. On a root-identity fixture the act-chain assertion is
    // vacuously green under any projection mutation — this is the limb that isn't.
    const child = await admin.impersonate(memberSub, star, { ttlSeconds: 300 });
    try {
      sink.length = 0;
      const invitee = em('acted');
      const summary = await facadeInvite(child, star, [{ email: invitee }]);
      expect(summary.results[0].outcome).toBe('invited');

      const issued = sink.filter((e) => e.namespace === 'nebula-auth.Registry.invite.issued');
      expect(issued).toHaveLength(1);
      const acting = issued[0].data.actingToken;
      // The full verified claims thread callContext.originAuth → facade → issueInvites: the
      // SUBJECT as `sub`, the DRIVER in `act` (mutation: project only `access` at the facade —
      // this limb reds), and the asserted authority.
      expect(acting.sub).toBe(memberSub);
      expect(acting.act?.sub).toBe(adminPayload.sub);
      expect(acting.access).toEqual({ authScope: star });
    } finally {
      child.disconnect();
      admin.disconnect();
    }
  });
});
