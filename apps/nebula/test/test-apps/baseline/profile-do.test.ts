/**
 * Profile DO (tasks/archive/nebula-profile-store.md): the global per-`profileId` DO's storage, the
 * OPEN public read, the `requireOwnerOrAdmin` gate (owner/super-admin short-circuit with NO read;
 * scoped-admin the ONE read), the private-notes gate, fail-closed, and LWW + forward-only eTag. Every
 * test is capable-of-failing.
 *
 * ⚠️ **Rung 3 is LOAD-BEARING here** (ADR-009 in-place justification): the fixtures seed registry
 * registry rows carrying a CHOSEN `profileId` so `getScopesForProfile(profileId)` resolves to a known
 * scope. Real issuance assigns `profileId` server-side, so the fixture could not be constructed through it.
 *
 * Harness: a plain `MeshClient` (mesh) with `refresh: createTestToken(...)` (ADR-009 rung 3,
 * justified per-site: these tests need PRECISE control over the `profileId` / `access` / scope claims,
 * which the cookie login can't give — and the baseline login lane is expectedly red mid-turnover). The
 * client connects to the REAL host node of its token's scope; the JWT is verified normally at the entrypoint.
 * The Profile DO is driven via `callAsync` — a remote `@mesh` throw REJECTS the promise. Runs in
 * isolation, not gated on the red baseline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { deploymentOrigin, platformOrigin, NEBULA_SUB } from '@lumenize/mesh/client';
import { MeshClient, mesh } from '@lumenize/mesh';
import type { ProfileChannelSnapshot } from '@lumenize/mesh';
import { Browser } from '@lumenize/testing';
import { createTestToken } from '@lumenize/mesh/auth/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import type { Profile, ProfileSnapshot } from '@lumenize/mesh/auth/profile';
import {
  createSubject, universeAdminClient, createInvitedClient, addressOfClient, pageOf } from '../../test-helpers';
import { FAIL_CLOSED_PROFILE_ID, NebulaClientTest } from './index';

/** Captures pushes on the dedicated profile channel — the subscribe() leg of the neither-list test. */
class MeshProbe extends MeshClient {
  profileUpdates: Array<{ profileId: string; snapshot: ProfileSnapshot }> = [];
  /**
   * When set, this tab answers every push by throwing a `ClientDisconnectedError` naming SOMEBODY
   * ELSE in a field of its own. The host node renames it before filling the Profile's continuation,
   * and the reaper never reads the field, so it names nobody.
   *
   * ⚠️ Armed on the SAME class rather than by a subclass override, deliberately: an override is a
   * new function and does not inherit `@mesh()`, which the entry rule refuses.
   */
  forgedVictim?: string;
  @mesh()
  override handleProfileUpdate(profileId: string, snapshot: ProfileChannelSnapshot | null | Error): void {
    if (this.forgedVictim) {
      throw Object.assign(new Error('client went away'), {
        name: 'ClientDisconnectedError', clientInstanceName: this.forgedVictim,
      });
    }
    this.profileUpdates.push({ profileId, snapshot: snapshot as ProfileSnapshot });
  }
}
function uuid(): string { return crypto.randomUUID(); }

/** A connected mesh client carrying a fully-controlled Nebula JWT (rung-3 mint). */
async function makeClient(opts: {
  profileId?: string; scopeAdmin?: boolean; instanceName?: string; activeScope?: string;
}): Promise<MeshProbe> {
  const activeScope = opts.activeScope ?? 'acme.app.tenant';
  const browser = new Browser();
  // On the page of the scope its token names, whose node hosts it.
  const ctx = browser.context(pageOf(activeScope));
  const client = new MeshProbe({
    baseUrl: pageOf(activeScope),
    refresh: createTestToken({
      issuer: platformOrigin(deploymentOrigin(env)),
      privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
      activeScope,
      instanceName: opts.instanceName ?? activeScope, // drives access.authScope
      scopeAdmin: opts.scopeAdmin ?? false,
      profileId: opts.profileId ?? uuid(), // every token carries one; a fresh one owns nothing
      sub: uuid(),
    }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

/**
 * Seed a registry address + membership so `getScopesForProfile(profileId)` → `[scope]` — the
 * scoped-admin fixture.
 *
 * ⚠️ **This builds a principal the REAL path builds differently — two stacked fixtures: this
 * hand-`INSERT`ed row AND `makeClient`'s synthetic rung-3 token.** So when the question is *is this
 * authz decision correct*, prefer `apps/nebula/harness/scenarios/profile-takeover-refused.ts`, which
 * proves the same property with a real login, a real invite and a real client — nothing hand-built.
 * This fixture is for reaching branches a client cannot construct, not for deciding correctness.
 *
 * ⚠️ **`accepted` is the whole point of the parameter, not a detail.** `getScopesForProfile` counts
 * only memberships that were actually taken up, because otherwise scope authority over a *global*
 * profile is manufacturable: claim a Universe, invite any address you can guess, and you "administer a
 * scope that profile touches" (ADR-012). Seeding `accepted: false` builds the manufactured shape, and a
 * fixture that always seeded accepted rows could never tell the guard from its absence.
 */
async function seedIdentity(profileId: string, scope: string, accepted = true): Promise<void> {
  const registry: any = (env as any).AUTH_REGISTRY.getByName('registry');
  const emailId = crypto.randomUUID();
  await (runInDurableObject as any)(registry, (_i: any, c: any) => {
    c.storage.sql.exec(
      `INSERT OR REPLACE INTO Emails (emailId, email, profileId, emailVerified, createdAt)
       VALUES (?,?,?,1,?)`,
      emailId, `${crypto.randomUUID()}@x.com`, profileId, '2026-01-01T00:00:00.000Z',
    );
    c.storage.sql.exec(
      `INSERT OR REPLACE INTO Memberships (sub, emailId, universeGalaxyStarId, scopeAdmin, acceptedAt, createdAt)
       VALUES (?,?,?,0,?,?)`,
      crypto.randomUUID(), emailId, scope,
      accepted ? '2026-01-01T00:00:00.000Z' : null, '2026-01-01T00:00:00.000Z',
    );
  });
}

// The Profile DO emits `nebula-auth.Profile.authz.registryRead` ONLY on the scoped-admin read path —
// the read-counter the "zero reads" / "exactly one read" criteria assert on (debug-sink catches DO-side
// markers in vitest-plugin).
let sink: any[] = [];
const registryReads = () => sink.filter((e) => e.namespace === 'nebula-auth.Profile.authz.registryRead').length;
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

const read = (c: MeshClient<any>, pid: string) => c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().read());
const write = (c: MeshClient<any>, pid: string, f: { name?: string; nickname?: string; picture?: string }) =>
  c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().writeProfile(f));
const readNotes = (c: MeshClient<any>, pid: string) => c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().readPrivateNotes());
const writeNotes = (c: MeshClient<any>, pid: string, n: string) => c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().writePrivateNotes(n));

describe('Profile DO', () => {
  /**
   * The THIRD package's reaper, driven rather than grepped.
   *
   * The Profile's reaper is its own `onProfileBroadcastResult`, reached through `lmz.broadcast` on
   * the one `UnscopedMeshDO` in the app. This drives it against
   * a forged reply: a tab answers a push by throwing a `ClientDisconnectedError` naming another
   * tab. The reaper takes its victim from the address it pushed to, so the named tab keeps its row;
   * and the tab's host node renames a Client's own `ClientDisconnectedError`, so the tab that threw
   * keeps its row too. Only a Client's server-side half says a Client is gone.
   */
  it('reaps neither the subscriber a forged reply names nor the one that forged it', async () => {
    const pid = uuid();
    await seedIdentity(pid, 'acme.app.tenant');
    using owner = await makeClient({ profileId: pid });
    using victim = await makeClient({ activeScope: 'acme.app.tenant' });
    using attacker = await makeClient({ activeScope: 'acme.app.tenant' });

    await victim.lmz.callAsync('PROFILE', pid, victim.ctn<Profile>().subscribe());
    await attacker.lmz.callAsync('PROFILE', pid, attacker.ctn<Profile>().subscribe());

    // POSITIVE CONTROL: both are live subscribers. Without it, "the victim stopped hearing" could
    // mean either subscription was never there, and every assertion below would pass vacuously.
    await write(owner, pid, { name: 'one' });
    await vi.waitFor(() => {
      expect(victim.profileUpdates.length).toBeGreaterThan(0);
      expect(attacker.profileUpdates.length).toBeGreaterThan(0);
    });

    // Arm, push once, and wait for the reaper's receipt of the forged reply before disarming: both
    // rows surviving would otherwise also be what a reply that never arrived looks like.
    attacker.forgedVictim = addressOfClient(victim);
    await write(owner, pid, { name: 'two' });
    const receipt = await vi.waitFor(() => {
      const heard = sink.find((e) => e.namespace === 'nebula-auth.Profile.reap'
        && e.data?.clientAddress === addressOfClient(attacker));
      expect(heard).toBeDefined();
      return heard;
    });
    attacker.forgedVictim = undefined;
    // MUTATION: skip the host node's rename of a thrown Error, and this names the reaped class.
    expect(receipt.data.name).toBe('Error');

    const victimBefore = victim.profileUpdates.length;
    const attackerBefore = attacker.profileUpdates.length;
    await write(owner, pid, { name: 'three' });
    await vi.waitFor(() => {
      expect(victim.profileUpdates.length).toBeGreaterThan(victimBefore);
      expect(attacker.profileUpdates.length).toBeGreaterThan(attackerBefore);
    });
  });

  it('public read is OPEN — a cross-scope non-admin caller reads, firing ZERO registry reads (#3)', async () => {
    const pid = uuid();
    await seedIdentity(pid, 'other-universe.app.tenant');            // the profile lives in a DIFFERENT scope
    using caller = await makeClient({ activeScope: 'acme.app.tenant', scopeAdmin: false }); // cross-scope, non-admin, non-owner
    const snap = await read(caller, pid);
    expect(snap.value).toEqual({});                                 // unwritten → empty public value
    expect(snap.meta.eTag).toBeTruthy();
    expect(registryReads()).toBe(0);                                // open read fires NO registry read (reds if a reach gate is added)
  });

  it('the read snapshot carries PUBLIC fields ONLY — no privateNotes leak (#4/#①)', async () => {
    const pid = uuid();
    const SENTINEL = `SECRET-${uuid()}`;
    using owner = await makeClient({ profileId: pid });             // owner: JWT profileId === instance
    await write(owner, pid, { name: 'Ada', nickname: 'ada', picture: 'https://x/a.png' });
    await writeNotes(owner, pid, SENTINEL);                         // seed a NON-empty privateNotes sentinel

    using reader = await makeClient({ activeScope: 'other.app.tenant', scopeAdmin: false });
    const snap = await read(reader, pid);
    expect(snap.value).toEqual({ name: 'Ada', nickname: 'ada', picture: 'https://x/a.png' });
    expect((snap.value as Record<string, unknown>).privateNotes).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain(SENTINEL);          // the blob appears NOWHERE in the payload
  });

  it('a field in NEITHER list is private WITHOUT being named — a seeded row outside the allow-list rides neither read() nor subscribe()', async () => {
    const pid = uuid();
    const ROGUE = `ROGUE-${uuid()}`;
    // No API writes such a field — itself the point: private-by-default must hold for a field nobody
    // classified. Seed it straight into ProfileFields with the DO's real ctx.
    const stub: any = (env as any).PROFILE.getByName(pid);
    await (runInDurableObject as any)(stub, (_i: any, c: any) => {
      c.storage.sql.exec(
        `INSERT OR REPLACE INTO ProfileFields (field, value) VALUES ('futureField', ?)`, ROGUE);
    });

    using reader = await makeClient({ scopeAdmin: false, profileId: uuid() });
    const snap = await read(reader, pid);
    expect((snap.value as Record<string, unknown>).futureField).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain(ROGUE);              // never rides read()

    // subscribe() delivers the initial snapshot on the dedicated profile channel — same exclusion.
    using sub = await makeClient({ scopeAdmin: false, profileId: uuid() });
    await sub.lmz.callAsync('PROFILE', pid, sub.ctn<Profile>().subscribe());
    await vi.waitFor(() => expect(sub.profileUpdates.length).toBe(1));
    expect(JSON.stringify(sub.profileUpdates)).not.toContain(ROGUE); // never rides subscribe()

    // Reds against a snapshot built by SUBTRACTION: mutate #publicSnapshot to exclude-known-private
    // (`WHERE field NOT IN ('privateNotes', 'eTag')`) and the rogue row rides both legs.
  });

  describe('requireOwnerOrAdmin — top-down, read only if forced (#5)', () => {
    it('OWNER writes pass with ZERO registry reads', async () => {
      const pid = uuid();
      using owner = await makeClient({ profileId: pid });
      await expect(write(owner, pid, { name: 'X' })).resolves.toBeUndefined();
      expect(registryReads()).toBe(0);
    });

    // A superuser's token is minted on some scope's host like anyone's, and acts on that host's
    // subtree alone (the host rule): the membership is the platform root, the page bounds it. The
    // `/live` witness is `superuser-end-to-end`'s last two limbs, through a real bootstrap login;
    // this keeps the branch beside the Profile's other authz cases.
    it("a SUPER-ADMIN's private access to a profile is bounded by the page, not the platform membership", async () => {
      const pid = uuid();
      await seedIdentity(pid, 'other.app.tenant');
      using fromAcme = await makeClient({ instanceName: '_platform', activeScope: 'acme.app.tenant', scopeAdmin: true, profileId: uuid() });
      await expect(write(fromAcme, pid, { name: 'X' })).rejects.toThrow(/does not cover/i);
      await expect(readNotes(fromAcme, pid)).rejects.toThrow(/does not cover/i);
      using fromOther = await makeClient({ instanceName: '_platform', activeScope: 'other', scopeAdmin: true, profileId: uuid() });
      await expect(write(fromOther, pid, { name: 'X' })).resolves.toBeUndefined();
    });

    // The one profile no scope finds: the system's own, ownerless and in no Registry. Its shortcut
    // is all that lets anyone edit it, so it answers before the read.
    it("a SUPER-ADMIN edits the system's own profile with ZERO reads — the one shortcut left", async () => {
      using su = await makeClient({ instanceName: '_platform', activeScope: 'acme', scopeAdmin: true, profileId: uuid() });
      await expect(write(su, NEBULA_SUB, { nickname: 'Lumenize' })).resolves.toBeUndefined();
      expect(registryReads()).toBe(0);
    });

    it('NON-admin NON-owner is rejected with ZERO reads', async () => {
      const pid = uuid();
      using stranger = await makeClient({ scopeAdmin: false, profileId: uuid() });
      await expect(write(stranger, pid, { name: 'X' })).rejects.toThrow(/owner or admin/i);
      expect(registryReads()).toBe(0);
    });

    it('SCOPED-admin covering the profile scope passes — with EXACTLY ONE read (positive control)', async () => {
      const pid = uuid();
      await seedIdentity(pid, 'acme.app.tenant');
      using admin = await makeClient({ instanceName: 'acme', activeScope: 'acme', scopeAdmin: true, profileId: uuid() }); // pattern acme.*
      await expect(write(admin, pid, { name: 'X' })).resolves.toBeUndefined();
      expect(registryReads()).toBe(1);                              // proves the counter is genuinely wired (not vacuous)
    });

    // ⚠️ **This REPLACES a skipped test written for the retire-the-branch design** ("SCOPED-admin ...
    // is REFUSED — owner + super-admin ONLY"). That target was reversed: admins curating a member's
    // private fields is a wanted capability, so the branch STAYS and what makes it safe is that only an
    // ACCEPTED membership counts (ADR-012). The old skip was left encoding a rejected model, which
    // testing.md calls actively harmful — a future reader takes it as settled intent.
    //
    // The pair below is the real contract, and the second half is the security assertion: an
    // unaccepted membership is exactly what an attacker manufactures by inviting an address they
    // guessed, so it must confer nothing.
    //
    // ⚠️ **Cross-arm, and NEITHER is a superset — do not delete one as redundant.** The live
    // counterpart (`harness/scenarios/profile-takeover-refused.ts`) proves the refusal a real caller
    // receives, with no fixture to build wrong. THIS arm sees what no client can: it runs in CI with
    // no email infrastructure, and it can reach the fail-closed branch and the read-counter by
    // constructing state a real login never produces. Each is blind to what the other sees.
    it('SCOPED-admin over a scope the profile ACCEPTED is permitted', async () => {
      const pid = uuid();
      await seedIdentity(pid, 'acme.app.tenant');                   // accepted
      using admin = await makeClient({ instanceName: 'acme', activeScope: 'acme', scopeAdmin: true, profileId: uuid() });
      await expect(write(admin, pid, { name: 'X' })).resolves.toBeUndefined();
    });

    it('SCOPED-admin over a scope the profile NEVER ACCEPTED is refused — the manufactured shape', async () => {
      const pid = uuid();
      await seedIdentity(pid, 'acme.app.tenant', /* accepted */ false);
      using admin = await makeClient({ instanceName: 'acme', activeScope: 'acme', scopeAdmin: true, profileId: uuid() });
      // Reds if `getScopesForProfile` drops its acceptance predicate — or swaps it for the address's
      // `emailVerified`, which is 1 here and would hand the attacker the scope.
      await expect(write(admin, pid, { name: 'X' })).rejects.toThrow();
      await expect(readNotes(admin, pid)).rejects.toThrow();
    });

    it('SCOPED-admin covering NONE of the profile scopes is rejected (cross-Galaxy admin) — one read, then deny', async () => {
      const pid = uuid();
      await seedIdentity(pid, 'acme.app.tenant');
      using admin = await makeClient({ instanceName: 'other-universe', activeScope: 'other-universe', scopeAdmin: true, profileId: uuid() });
      await expect(write(admin, pid, { name: 'X' })).rejects.toThrow(/does not cover/i);
      expect(registryReads()).toBe(1);
    });
  });

  describe('privateNotes gate = requireOwnerOrAdmin, via a SEPARATE gated read (#6)', () => {
    it('the OWNER reads privateNotes; a caller who can read the PUBLIC fields is DENIED the blob', async () => {
      const pid = uuid();
      const SENTINEL = `SECRET-${uuid()}`;
      using owner = await makeClient({ profileId: pid });
      await writeNotes(owner, pid, SENTINEL);
      await expect(readNotes(owner, pid)).resolves.toBe(SENTINEL);          // owner reads it

      using stranger = await makeClient({ scopeAdmin: false, profileId: uuid() });
      await expect(read(stranger, pid)).resolves.toBeDefined();             // CAN read public fields (open)...
      await expect(readNotes(stranger, pid)).rejects.toThrow(/owner or admin/i); // ...but NOT the blob
    });
  });

  it('fail-closed: a scoped-admin whose registry read THROWS is DENIED, never allowed (#8)', async () => {
    // ProfileTest.lookupProfileScopes throws for FAIL_CLOSED_PROFILE_ID → #requireOwnerOrAdmin must catch + deny.
    using admin = await makeClient({ instanceName: 'acme', activeScope: 'acme', scopeAdmin: true, profileId: uuid() });
    await expect(write(admin, FAIL_CLOSED_PROFILE_ID, { name: 'X' })).rejects.toThrow(/authz check failed/i);
  });

  // ── A NARROWER token IS the OWNER (tasks/archive/nebula-mint-narrower-token.md) ─────────────────
  // ⚠️ **This test is ADR-009 RUNG 2 and does NOT inherit this file's rung-3 header.** The whole
  // point is the token minted by the production impersonation mint, so the principals are a real
  // star-scoped admin and a real invited member, and the token under test comes from the facade via
  // the production client capability, `admin.impersonate()`. (It was labelled rung 1 before
  // tasks/archive/nebula-impersonation-client.md; that was wrong — rung 1 is the real email
  // transport, which the `baseline` lane does not use.)
  //
  // ⚠️ **This assertion was INVERTED, and the inversion is the design.** It used to assert a refusal,
  // because the owner branch carried a no-actor-chain conjunct. That conjunct is gone: acceptance is
  // enforced at the mint instead, so a token carrying somebody's `profileId` cannot exist unless they
  // took their membership up — and an impersonated session is therefore that person at their own
  // profile, exactly as it is everywhere else in the system. ADR-012 § *Alternatives considered*
  // carries the retired clause and why; `security.md` rule (1) says why it is not a worked case.
  //
  // With a NON-admin subject the minted token carries no `scopeAdmin` claim, so branch (2) would
  // reject and branch (4) is never reached — the owner branch is the ONLY thing that can admit this
  // write, which is what the zero-read assertion below pins.
  it('a NARROWER token IS the owner — the admin driving it writes and reads privateNotes, zero reads', async () => {
    const universe = `pdo-${uuid().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();
    const { client: admin, accessToken: adminToken } = await universeAdminClient(
      NebulaClientTest, browser, star, star, 'admin@example.com',
    );
    await createSubject(browser, star, adminToken, 'member@example.com');
    // The owner CONTROL is a real cookie-login client — see the note at the control below for why it
    // cannot be an `impersonate()` product.
    const { client: ownerClient, payload: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'member@example.com',
    );
    const pid = member.profileId!;
    expect(pid).toBeDefined();

    using impersonating = await admin.impersonate(member.sub);
    await vi.waitFor(() => expect(impersonating.connectionState).toBe('connected'));
    // Fixture guards. The token carries the SUBJECT's `profileId`, so the owner branch's zero-read
    // equality is what matches; it really does carry an actor chain, so this is not an ordinary login
    // wearing a different name.
    expect(impersonating.claims.profileId).toBe(pid);
    expect(impersonating.claims.act?.sub).toBeDefined();
    expect(impersonating.claims.access.scopeAdmin).toBeUndefined(); // non-admin subject → branch (2) would reject

    const SENTINEL = `SECRET-${uuid()}`;
    await writeNotes(ownerClient, pid, SENTINEL); // the member's own note, written by the member

    // Mutation: restore `&& !claims.act` on the owner branch → both of these red.
    sink.length = 0;
    await expect(write(impersonating, pid, { name: 'X' })).resolves.toBeUndefined();
    await expect(readNotes(impersonating, pid)).resolves.toBe(SENTINEL);

    // ⚠️ **Zero reads is the PROPERTY, not the discriminator.** What already proves branch (1) admitted
    // the write is the fixture guard above — a subject with no `scopeAdmin` claim is rejected by
    // branch (2) before any registry read, so no admin branch is reachable. This asserts the separate
    // thing the owner branch promises: it costs nothing. It reds on its own if the owner branch ever
    // starts reading the registry, which neither assertion above would notice.
    expect(registryReads()).toBe(0);

    // Control: the member's OWN cookie login (same `profileId`, no chain) is the owner too, which is
    // the point — the two sessions are the same person at this DO.
    //
    // ⚠️ **This one deliberately does NOT use `impersonate()`, and cannot.** Every token that method
    // mints carries an actor chain, so an impersonated "control" would be a second copy of the arm
    // above rather than a control on it.
    await expect(write(ownerClient, pid, { name: 'Y' })).resolves.toBeUndefined();

    // Every other client in this file is `using`-scoped; these two are plain consts because
    // `impersonate()` needs a live parent. Dispose explicitly so they do not hold sockets on their host node
    // open for the rest of the run.
    admin.disconnect();
    ownerClient.disconnect();
  });

  it('LWW + forward-only eTag: a second write REPLACES fields and advances the eTag; no OCC (#9)', async () => {
    const pid = uuid();
    using owner = await makeClient({ profileId: pid });
    await write(owner, pid, { name: 'A', nickname: 'aa' });
    const s1 = await read(owner, pid);
    await write(owner, pid, { name: 'B' });                          // REPLACES — nickname drops (LWW, not merge)
    const s2 = await read(owner, pid);
    expect(s2.value).toEqual({ name: 'B' });                        // replaced, not merged
    expect(s2.meta.eTag).not.toBe(s1.meta.eTag);
    expect(s2.meta.eTag > s1.meta.eTag).toBe(true);                 // forward-only (monotonic ULID)
  });
});
