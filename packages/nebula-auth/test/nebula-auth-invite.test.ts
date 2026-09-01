/**
 * Invite flow — the per-invitee Registry primitive, plus the shared invite-entry helpers.
 *
 * Issuance MINTS per invitee (`invitees: [{ email, scopeAdmin? }]`) and names its outcome
 * (`invited | already-member | promoted`); re-inviting an existing non-admin member WITH the bit
 * promotes them (and converges their live sessions); the invite token is REUSABLE within its TTL
 * (scanner-safe — deleted only by the expiry sweep); `issueInvites` is mint-only — the entry
 * (production: the mesh facade, covered in apps/nebula's baseline lane) dispatches mail
 * post-return through `sendInviteEmails`, template picked by ACCEPTANCE.
 *
 * Issuance here is a direct Registry RPC with claims parsed off a REAL server-minted token
 * (`issueInvitesAs`) — there is no HTTP invite route any more, and this package has no mesh stack
 * to host the facade. ADR-009 still binds: the persisted bit is asserted through the real path
 * (accept → refresh → the JWT), never the mint result alone. Template tests assert on the REAL
 * message handed to the sender — never a test-mode `links` map (the recorded 2026-08-04 defect).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { sendInviteEmails, summarizeInvites } from '../src/invite-entry';
import type { EmailMessage, InviteMintResult, NebulaJwtPayload } from '../src/types';
import {
  foundUniverse, issueInvitesAs, clickLink, refreshAndParse, url, createGalaxy, inviteAndLogin,
  acceptMembership,
} from './test-helpers';
import { parseJwtUnsafe } from '@lumenize/crypto';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function em(tag: string): string { return `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }

/** The mint result's invite URL for one address. */
function linkFor(mint: InviteMintResult, email: string): string {
  const row = mint.results.find(r => r.email === email);
  expect(row, email).toBeDefined();
  return row!.inviteUrl;
}

/** Accept an invite link and refresh at `scope` → the parsed JWT payload (the ADR-009 path). */
async function acceptAndParse(link: string, scope: string): Promise<NebulaJwtPayload> {
  // The consent step is not optional: a cookie minted at the click is inert until its holder
  // accepts, so a click-then-refresh 401s — which is the design, not a fixture detail.
  const { tokenFor } = await clickLink(SELF, link);
  const refreshToken = tokenFor(scope);
  await acceptMembership(SELF, scope, refreshToken);
  const { parsed } = await refreshAndParse(SELF, scope, refreshToken);
  return parsed as NebulaJwtPayload;
}

/** The InviteTokens rows for (email, scope) — reusable-TTL asserts on the actual stored rows. */
async function inviteRows(email: string, scope: string): Promise<Array<{ expiresAt: string }>> {
  return (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => [...c.storage.sql.exec(
    'SELECT expiresAt FROM InviteTokens WHERE email = ? AND universeGalaxyStarId = ?', email, scope,
  )]);
}

describe('Galaxy invite — the workspace SECOND HALF (collapse Phase 4)', () => {
  it('a galaxy invite co-mints a `.dev` scopeAdmin membership, and ONE acceptance click seeds BOTH sessions', async () => {
    const u = uni();
    const galaxy = `${u}.app`;
    const admin = await foundUniverse(SELF, u, em('adm'));
    expect((await createGalaxy(SELF, galaxy, admin.access_token)).status).toBe(201);

    const invitee = em('austen');
    const mint = await issueInvitesAs(admin.access_token, galaxy, [{ email: invitee }]);

    // ONE click → TWO Set-Cookie headers, Path-scoped per enrolled scope.
    const resp = await SELF.fetch(new Request(linkFor(mint, invitee), { redirect: 'manual' }));
    expect(resp.status).toBe(302);
    const cookies = resp.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const galaxyCookie = cookies.find((c) => c.includes(`Path=/auth/${galaxy};`))!;
    const devCookie = cookies.find((c) => c.includes(`Path=/auth/${galaxy}.dev;`))!;
    expect(galaxyCookie, 'a refresh cookie Path-scoped to the galaxy').toBeTruthy();
    expect(devCookie, 'a SECOND refresh cookie Path-scoped to the .dev workspace').toBeTruthy();

    // The galaxy session mints NO admin bit (the collaborator is a peer there)…
    const galaxyToken = galaxyCookie.split(';')[0]!.split('=')[1]!;
    // ONE consent covers the bundle the invite arrived as: accepting the galaxy takes up the
    // co-minted `.dev` sibling too, so the second session below needs no second Accept.
    await acceptMembership(SELF, galaxy, galaxyToken);
    const { parsed: gp } = await refreshAndParse(SELF, galaxy, galaxyToken);
    expect(gp.access.authScope).toBe(galaxy);
    expect(gp.access.scopeAdmin).toBeUndefined();
    // …and the workspace session mints scopeAdmin over the `.dev` Star — dominion over
    // the workspace IS the whole grant (the pinned second half).
    const devToken = devCookie.split(';')[0]!.split('=')[1]!;
    const { parsed: dp } = await refreshAndParse(SELF, `${galaxy}.dev`, devToken);
    expect(dp.access.authScope).toBe(`${galaxy}.dev`);
    expect(dp.access.scopeAdmin).toBe(true);
    // The two sessions are the SAME person (one address → one profileId)…
    expect(dp.profileId).toBe(gp.profileId);
    // …but DIFFERENT memberships (sub is per-(email, scope) — ADR-013 keys on sub).
    expect(dp.sub).not.toBe(gp.sub);
  });

  it('a PEER inviter (no dominion) co-mints the `.dev` membership WITHOUT the admin bit', async () => {
    // The escalation this prices: `issueInvites` is reachable by an exact-scope MEMBER
    // (the facade admits `authScope === targetScope` OR dominion), so an unconditional
    // `.dev` admin co-mint let a peer hand a third party admin over the whole workspace —
    // authority the inviter does not hold and cannot delegate (ADR-015: upward is nil).
    const u = uni();
    const galaxy = `${u}.app`;
    const admin = await foundUniverse(SELF, u, em('adm'));
    expect((await createGalaxy(SELF, galaxy, admin.access_token)).status).toBe(201);

    // A real peer: invited by the admin with NO bit, then logged in through the real
    // acceptance. Their token is the caller below — a member of the galaxy, no dominion.
    const peerEmail = em('peer');
    const peer = await inviteAndLogin(SELF, galaxy, admin.access_token, peerEmail);
    const peerClaims = parseJwtUnsafe(peer.access_token)!.payload as unknown as NebulaJwtPayload;
    // The fixture guard — without these the assertion below cannot fail for its own reason.
    expect(peerClaims.access.scopeAdmin).toBeUndefined();
    expect(peerClaims.access.authScope).toBe(galaxy);

    const third = em('third');
    const mint = await issueInvitesAs(peer.access_token, galaxy, [{ email: third }]);
    expect(mint.errors).toHaveLength(0);

    // Both sessions still seed — collaboration is not the thing being withheld …
    const resp = await SELF.fetch(new Request(linkFor(mint, third), { redirect: 'manual' }));
    expect(resp.status).toBe(302);
    const cookies = resp.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    // … but the workspace session carries NO admin bit, because the inviter had none to give.
    const devCookie = cookies.find((c) => c.includes(`Path=/auth/${galaxy}.dev;`))!;
    const devToken = devCookie.split(';')[0]!.split('=')[1]!;
    // Consent first — the invitee accepts the galaxy, which takes up its `.dev` sibling with it.
    const galaxyToken2 = cookies.find((c) => c.includes(`Path=/auth/${galaxy};`))!.split(';')[0]!.split('=')[1]!;
    await acceptMembership(SELF, galaxy, galaxyToken2);
    const { parsed: dp } = await refreshAndParse(SELF, `${galaxy}.dev`, devToken);
    expect(dp.access.authScope).toBe(`${galaxy}.dev`);
    expect(dp.access.scopeAdmin).toBeUndefined();
  });

  it('a UNIVERSE invite stays single-session (the second half is galaxy-tier only)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, em('adm'));
    const invitee = em('solo');
    const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee }]);
    const resp = await SELF.fetch(new Request(linkFor(mint, invitee), { redirect: 'manual' }));
    expect(resp.status).toBe(302);
    expect(resp.headers.getSetCookie()).toHaveLength(1);
  });
});

describe('Invite Flow (per-invitee primitive)', () => {
  const entries: any[] = [];
  beforeEach(() => {
    entries.length = 0;
    setDebugSink((e) => entries.push(e));
  });
  afterEach(() => { clearDebugSink(); });

  describe('the persisted bit rides the real path (accept → refresh → JWT)', () => {
    it('(i) a net-new scopeAdmin:true invitee\'s JWT carries the bit', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const invitee = em('newadmin');

      const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee, scopeAdmin: true }]);
      expect(mint.results).toHaveLength(1);
      expect(mint.results[0]).toMatchObject({ email: invitee, outcome: 'invited' });
      expect(mint.results[0].sub).toBeTruthy();

      // The REAL path: accept the minted link, refresh, read the claim off the JWT.
      const parsed = await acceptAndParse(linkFor(mint, invitee), u);
      expect(parsed.access.scopeAdmin).toBe(true);
      expect(parsed.access.authScope).toBe(u);
    });

    it('(ii)+(promotion) re-inviting an existing non-admin member WITH the bit promotes them — JWT carries it', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const member = em('member');

      // Plain member first: invited without the bit, accepted for real.
      const first = await issueInvitesAs(admin.access_token, u, [{ email: member }]);
      expect(first.results[0].outcome).toBe('invited');
      const before = await acceptAndParse(linkFor(first, member), u);
      expect(before.access.scopeAdmin).toBeUndefined(); // non-admin claim omits the bit

      // Re-invite WITH the bit — reds against the membership early-return leaving the bit untouched.
      const second = await issueInvitesAs(admin.access_token, u, [{ email: member, scopeAdmin: true }]);
      expect(second.results[0].outcome).toBe('promoted');

      // Fresh real login through the NEW link: the row's bit is what the JWT mints from.
      const after = await acceptAndParse(linkFor(second, member), u);
      expect(after.access.scopeAdmin).toBe(true);
      expect(after.sub).toBe(before.sub); // same membership — promoted, not duplicated
    });

    it('(iii) an omitted flag, an explicit false, and a wrong-typed "false" each leave the bit 0', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const omitted = em('omitted');
      const explicit = em('explicit');
      const wrongTyped = em('wrongtyped');

      const mint = await issueInvitesAs(admin.access_token, u, [
        { email: omitted },
        { email: explicit, scopeAdmin: false },
        // Wrong-typed: MUST be treated as unrequested, never truthy — reds if the `=== true`
        // boundary is relaxed to truthiness.
        { email: wrongTyped, scopeAdmin: 'false' as unknown as boolean },
      ]);
      expect(mint.errors).toHaveLength(0);
      for (const invitee of [omitted, explicit, wrongTyped]) {
        const parsed = await acceptAndParse(linkFor(mint, invitee), u);
        expect(parsed.access.scopeAdmin).toBeUndefined();
      }
    });

    it('a mixed batch mints a admin and b not — the flag is per-invitee, never batch-level', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const a = em('mixed-a');
      const b = em('mixed-b');

      const mint = await issueInvitesAs(admin.access_token, u, [
        { email: a, scopeAdmin: true },
        { email: b },
      ]);
      const parsedA = await acceptAndParse(linkFor(mint, a), u);
      const parsedB = await acceptAndParse(linkFor(mint, b), u);
      expect(parsedA.access.scopeAdmin).toBe(true);
      expect(parsedB.access.scopeAdmin).toBeUndefined();
    });
  });

  describe('promotion converges live sessions', () => {
    it('a pre-existing session gains the bit on its next refresh WITHOUT clicking the new link', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const member = em('livemember');

      // Establish a real non-admin session and HOLD its refresh cookie.
      const first = await issueInvitesAs(admin.access_token, u, [{ email: member }]);
      const { tokenFor } = await clickLink(SELF, linkFor(first, member));
      const refreshToken = tokenFor(u);
      await acceptMembership(SELF, u, refreshToken); // a live session needs a taken-up membership
      const before = await refreshAndParse(SELF, u, refreshToken);
      expect(before.parsed.access.scopeAdmin).toBeUndefined();

      // Promote — the new link is deliberately NEVER clicked.
      const second = await issueInvitesAs(admin.access_token, u, [{ email: member, scopeAdmin: true }]);
      expect(second.results[0].outcome).toBe('promoted');

      // The pre-existing session's next refresh reads the CONVERGED KV record. This limb is what
      // reds when setIdentityAdmin's KV re-put loop is dropped — the accept→refresh limbs above
      // stay green under that mutation (a fresh login re-records KV from the row).
      const after = await refreshAndParse(SELF, u, refreshToken);
      expect(after.parsed.access.scopeAdmin).toBe(true);
    });
  });

  describe('promote-only is structural, both directions', () => {
    it('(a) a capped-FALSE re-invite of an existing ADMIN leaves the bit 1 — never a demotion', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const target = em('demote-target');

      const first = await issueInvitesAs(admin.access_token, u, [{ email: target, scopeAdmin: true }]);
      await acceptAndParse(linkFor(first, target), u);

      // Re-invite WITHOUT the bit — under the promote-only rule this means "no promotion", never
      // "demote". Reds against passing the capped bit to setIdentityAdmin unconditionally (the
      // demotion primitive this criterion exists to forbid).
      const second = await issueInvitesAs(admin.access_token, u, [{ email: target }]);
      expect(second.results[0].outcome).toBe('already-member');

      const parsed = await acceptAndParse(linkFor(second, target), u);
      expect(parsed.access.scopeAdmin).toBe(true); // the bit SURVIVED into a real-login JWT
    });

    it('(b) an already-admin re-invite WITH the bit is an ordinary already-member — no update, no KV writes, no authority-change record', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const target = em('readmin');

      const first = await issueInvitesAs(admin.access_token, u, [{ email: target, scopeAdmin: true }]);
      await acceptAndParse(linkFor(first, target), u);
      entries.length = 0;

      const second = await issueInvitesAs(admin.access_token, u, [{ email: target, scopeAdmin: true }]);
      expect(second.results[0].outcome).toBe('already-member'); // never a false `promoted`

      // setIdentityAdmin is the only writer of the roleUpdated record AND of the KV re-puts, so
      // its marker's absence is the no-update/no-KV-write assertion. Reds against dropping the
      // changed-from guard (bit already 1 → the call must not be reached).
      const roleUpdated = entries.filter(e => e.namespace === 'nebula-auth.Registry.identity.roleUpdated');
      expect(roleUpdated).toHaveLength(0);
    });
  });

  describe('outcome discriminants are truthful', () => {
    it('invited / already-member / promoted each observed; a malformed entry joins errors while the batch succeeds', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const member = em('outcome-member');

      const first = await issueInvitesAs(admin.access_token, u, [{ email: member }]);
      expect(first.results[0].outcome).toBe('invited');

      // Mixed batch: a re-invite (already-member), a promotion, a fresh mint, and malformed entries.
      const promotee = em('outcome-promotee');
      await issueInvitesAs(admin.access_token, u, [{ email: promotee }]);
      const batch = await issueInvitesAs(admin.access_token, u, [
        { email: member },                          // exists, no bit → already-member
        { email: promotee, scopeAdmin: true },      // exists, bit, row bit 0 → promoted
        { email: em('outcome-new') },               // fresh → invited
        { email: 'not-an-email' },                  // malformed → per-invitee error
        { notEven: 'an object shape' } as any,      // malformed → per-invitee error
      ]);
      const byEmail = Object.fromEntries(batch.results.map(r => [r.email, r.outcome]));
      expect(byEmail[member]).toBe('already-member');
      expect(byEmail[promotee]).toBe('promoted');
      expect(Object.values(byEmail)).toContain('invited');
      expect(batch.errors).toHaveLength(2);
      expect(batch.errors[0].error).toBe('Invalid email format');
    });
  });

  describe('reusable within TTL (scanner-safe)', () => {
    it('a second GET of the same link within TTL logs in again; the row dies only at the expiry sweep', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const invitee = em('scanned');

      const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee }]);
      const link = linkFor(mint, invitee);

      // The scanner-then-human sequence: both GETs must log in.
      const first = await SELF.fetch(new Request(link, { redirect: 'manual' }));
      expect(first.status).toBe(302);
      expect(first.headers.get('Set-Cookie')).toContain('refresh-token=');

      const second = await SELF.fetch(new Request(link, { redirect: 'manual' }));
      expect(second.status).toBe(302);
      expect(second.headers.get('Set-Cookie')).toContain('refresh-token=');
      expect(second.headers.get('Location')).not.toContain('error=');

      // The row survived both consumes…
      expect(await inviteRows(invitee, u)).toHaveLength(1);

      // …and dies only at the expiry sweep: age it past expiry, fire the sweep (the alarm tick),
      // and the row is gone — after which the link is inert.
      await (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => {
        c.storage.sql.exec(
          'UPDATE InviteTokens SET expiresAt = ? WHERE email = ? AND universeGalaxyStarId = ?',
          '2000-01-01T00:00:00.000Z', invitee, u,
        );
      });
      await (runInDurableObject as any)(getRegistry(), (instance: any) => instance.alarm());
      expect(await inviteRows(invitee, u)).toHaveLength(0);
      const dead = await SELF.fetch(new Request(link, { redirect: 'manual' }));
      expect(dead.headers.get('Location')).toContain('error=invalid_token');
    });
  });

  describe('the send left the Registry DO — the entry helpers own dispatch', () => {
    // The production entry is the mesh facade (apps/nebula baseline lane), which fires
    // `sendInviteEmails` under `ctx.waitUntil` AFTER producing the summary; the end-to-end real
    // dispatch is the /live invite scenario. What THIS lane owns is the helper contract the facade
    // leans on: never rejects, per-invitee catch with identifiers only, template by acceptance —
    // each driven with a REAL registry mint result, so no fixture shapes the input.

    it('a failing sender never rejects the returned promise; the failure is logged per-invitee with identifiers only', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const invitee = em('failed-send');
      const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee }]);

      const envStub = {
        AUTH_EMAIL_SENDER: { send: () => Promise.reject(new Error('provider exploded')) },
      };
      // Reds against dropping the per-invitee catch: the rejection would surface here.
      await expect(sendInviteEmails(envStub, {
        instanceName: u, origin: 'http://localhost', invitees: mint.results,
      })).resolves.toBeUndefined();

      const failures = entries.filter(e =>
        e.namespace === 'nebula-auth.invite.send' && e.level === 'error');
      expect(failures).toHaveLength(1);
      expect(failures[0].data.email).toBe(invitee);
      expect(failures[0].data.instanceName).toBe(u);
      // Identifiers only — never the URL or its token (critical.md).
      expect(JSON.stringify(failures[0].data)).not.toContain('invite_token');
    });

    it('template selection discriminates on ACCEPTANCE, observed on the real message; the fresh link is deliverable', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const acceptedMember = em('accepted');
      const pendingInvitee = em('pending');

      // Seed: one member who ACCEPTED, one invitee who never clicked. (Row-exists discrimination
      // would send both the redirect letter — the stranded, link-less shape this test reds on.)
      const seed = await issueInvitesAs(admin.access_token, u, [{ email: acceptedMember }, { email: pendingInvitee }]);
      await acceptAndParse(linkFor(seed, acceptedMember), u);

      // Re-invite BOTH; hand the real mint result to the real send helper with a capturing sender.
      const reinvite = await issueInvitesAs(admin.access_token, u, [{ email: acceptedMember }, { email: pendingInvitee }]);
      const captured: EmailMessage[] = [];
      await sendInviteEmails(
        { AUTH_EMAIL_SENDER: { send: async (m: EmailMessage) => { captured.push(m); } } },
        { instanceName: u, origin: 'http://localhost', invitees: reinvite.results },
      );
      expect(captured).toHaveLength(2);
      const toAccepted = captured.find(m => m.to === acceptedMember)!;
      const toPending = captured.find(m => m.to === pendingInvitee)!;
      expect(toAccepted.type).toBe('invite-existing'); // reds against always-invite-new
      expect(toPending.type).toBe('invite-new');

      // The pending letter carries the FRESH link, and consuming THAT DELIVERED message's link
      // logs them in — the recovery story, asserted on the message that went to the sender.
      const inviteUrl = (toPending as { inviteUrl: string }).inviteUrl;
      expect(inviteUrl).toContain('accept-invite');
      const parsed = await acceptAndParse(inviteUrl, u);
      expect(parsed.access.authScope).toBe(u);
    });

    it('the caller-facing summary strips what the sender needs; test mode\'s links is the only URL carrier', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const invitee = em('strip');
      const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee }]);

      // Production shape: no links key, no URL anywhere. Reds against unfiltered pass-through.
      const prod = summarizeInvites(mint, false);
      expect(prod.links).toBeUndefined();
      expect(JSON.stringify(prod)).not.toContain('invite_token');
      expect(Object.keys(prod.results[0]).sort()).toEqual(['email', 'outcome', 'sub']);

      // Test-mode shape: links per normalized email, as before the reshape.
      const test = summarizeInvites(mint, true);
      expect(test.links![invitee]).toContain('accept-invite');
    });
  });

  describe('the in-method cap re-assertion', () => {
    it('a direct DO call carrying scopeAdmin:true with non-dominion callerClaims throws (invariant breach)', async () => {
      const u = uni();
      // A hand-built NON-dominion claims object (ADR-009 rung 4 — a negative control the real path
      // cannot produce, since every live entry caps the bit before the RPC).
      const nonDominionClaims = {
        iss: 'test', aud: 'other-universe', sub: crypto.randomUUID(),
        exp: 0, iat: 0, jti: crypto.randomUUID(),
        access: { authScope: 'other-universe' },
      };
      const victim = em('victim');
      // Reds against removing the re-assert. Raw RPC: sync-looking DO methods reject async.
      await expect(
        getRegistry().issueInvites(u, [{ email: victim, scopeAdmin: true }], 'http://localhost', nonDominionClaims),
      ).rejects.toThrow(/invariant breach/);
      // And nothing was minted for the batch — the throw precedes every write.
      const disc = await getRegistry().discover(victim);
      expect(disc).toEqual([]);
    });
  });

  describe('GET /accept-invite (the click stays HTTP — session lifecycle)', () => {
    it('rejects a missing invite_token (400)', async () => {
      const resp = await SELF.fetch(new Request(url('someu', 'accept-invite'), { redirect: 'manual' }));
      expect(resp.status).toBe(400);
      expect((await resp.json() as any).error).toBe('invalid_request');
    });

    it('rejects an invalid invite token (302 error redirect)', async () => {
      const resp = await SELF.fetch(new Request(url('someu', 'accept-invite?invite_token=bogus'), { redirect: 'manual' }));
      expect(resp.status).toBe(302);
      expect(resp.headers.get('Location')).toContain('error=invalid_token');
    });
  });

  describe('there is no HTTP invite surface (structural)', () => {
    it('POST /auth/{scope}/invite 404s — the route table carries no row for it', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const resp = await SELF.fetch(new Request(url(u, 'invite'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitees: [{ email: em('x') }] }),
      }));
      expect(resp.status).toBe(404);
    });
  });

  describe('re-invite idempotency', () => {
    it('re-inviting the same email keeps ONE identity — the second outcome is already-member', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, em('adm'));
      const dup = em('dup');
      const first = await issueInvitesAs(admin.access_token, u, [{ email: dup }]);
      expect(first.results[0].outcome).toBe('invited');
      const second = await issueInvitesAs(admin.access_token, u, [{ email: dup }]);
      expect(second.results[0].outcome).toBe('already-member');
      expect(second.results[0].sub).toBe(first.results[0].sub);
      expect(await getRegistry().discover(dup)).toHaveLength(1);
    });
  });
});
