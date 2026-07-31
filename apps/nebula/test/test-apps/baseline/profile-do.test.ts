/**
 * Profile DO — Phase 2 (tasks/nebula-profile-store.md): the global per-`profileId` DO's storage, the
 * OPEN public read, the `requireOwnerOrAdmin` gate (owner/super-admin short-circuit with NO read;
 * scoped-admin the ONE read), the private-notes gate, fail-closed, and LWW + forward-only eTag. Every
 * test is capable-of-failing.
 *
 * ⚠️ **Rung 3 is LOAD-BEARING here** (ADR-009 in-place justification): the fixtures seed registry
 * `Identities` rows keyed on a CHOSEN `profileId` so `getScopesForProfile(profileId)` resolves to a known
 * scope. Real issuance assigns `profileId` server-side, so the fixture could not be constructed through it.
 *
 * Harness: a plain `LumenizeClient` (mesh) with `refresh: createNebulaTestToken(...)` (ADR-009 rung 3,
 * justified per-site: these tests need PRECISE control over the `profileId` / `access` / scope claims,
 * which the cookie login can't give — and the baseline login lane is expectedly red mid-turnover). The
 * client connects to the REAL `NebulaClientGateway`; the JWT is verified normally at the entrypoint.
 * The Profile DO is driven via `callAsync` — a remote `@mesh` throw REJECTS the promise. Runs in
 * isolation, not gated on the red baseline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { LumenizeClient } from '@lumenize/mesh';
import { Browser } from '@lumenize/testing';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import type { Profile } from '@lumenize/nebula-auth/profile';
import {
  createSubject, universeAdminClient, createInvitedClient,
} from '../../test-helpers';
import { FAIL_CLOSED_PROFILE_ID, NebulaClientTest } from './index';

const ORIGIN = 'http://localhost';
class MeshProbe extends LumenizeClient {}
function uuid(): string { return crypto.randomUUID(); }

/** A connected mesh client carrying a fully-controlled Nebula JWT (rung-3 mint). */
async function makeClient(opts: {
  profileId?: string; isAdmin?: boolean; instanceName?: string; activeScope?: string;
}): Promise<MeshProbe> {
  const activeScope = opts.activeScope ?? 'acme.app.tenant';
  const browser = new Browser();
  const ctx = browser.context(ORIGIN);
  const client = new MeshProbe({
    baseUrl: ORIGIN,
    gatewayBindingName: 'NEBULA_CLIENT_GATEWAY',
    refresh: createNebulaTestToken({
      privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
      activeScope,
      instanceName: opts.instanceName ?? activeScope, // drives access.authScopePattern
      isAdmin: opts.isAdmin ?? false,
      profileId: opts.profileId,
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

/** Seed a registry `Identities` row so `getScopesForProfile(profileId)` → `[scope]` (scoped-admin fixture). */
async function seedIdentity(profileId: string, scope: string): Promise<void> {
  const registry: any = (env as any).NEBULA_AUTH_REGISTRY.getByName('registry');
  await (runInDurableObject as any)(registry, (_i: any, c: any) => {
    c.storage.sql.exec(
      `INSERT OR REPLACE INTO Identities (sub, profileId, universeGalaxyStarId, email, isAdmin, emailVerified, createdAt)
       VALUES (?,?,?,?,0,1,?)`,
      crypto.randomUUID(), profileId, scope, `${crypto.randomUUID()}@x.com`, '2026-01-01T00:00:00.000Z',
    );
  });
}

// The Profile DO emits `nebula-auth.Profile.authz.registryRead` ONLY on the scoped-admin read path —
// the read-counter the "zero reads" / "exactly one read" criteria assert on (debug-sink catches DO-side
// markers in pool-workers).
let sink: any[] = [];
const registryReads = () => sink.filter((e) => e.namespace === 'nebula-auth.Profile.authz.registryRead').length;
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

const read = (c: LumenizeClient<any>, pid: string) => c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().read());
const write = (c: LumenizeClient<any>, pid: string, f: { name?: string; nickname?: string; picture?: string }) =>
  c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().writeProfile(f));
const readNotes = (c: LumenizeClient<any>, pid: string) => c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().readPrivateNotes());
const writeNotes = (c: LumenizeClient<any>, pid: string, n: string) => c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().writePrivateNotes(n));

describe('Profile DO — Phase 2', () => {
  it('public read is OPEN — a cross-scope non-admin caller reads, firing ZERO registry reads (#3)', async () => {
    const pid = uuid();
    await seedIdentity(pid, 'other-universe.app.tenant');            // the profile lives in a DIFFERENT scope
    using caller = await makeClient({ activeScope: 'acme.app.tenant', isAdmin: false }); // cross-scope, non-admin, non-owner
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

    using reader = await makeClient({ activeScope: 'other.app.tenant', isAdmin: false });
    const snap = await read(reader, pid);
    expect(snap.value).toEqual({ name: 'Ada', nickname: 'ada', picture: 'https://x/a.png' });
    expect((snap.value as Record<string, unknown>).privateNotes).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain(SENTINEL);          // the blob appears NOWHERE in the payload
  });

  describe('requireOwnerOrAdmin — top-down, read only if forced (#5)', () => {
    it('OWNER writes pass with ZERO registry reads', async () => {
      const pid = uuid();
      using owner = await makeClient({ profileId: pid });
      await expect(write(owner, pid, { name: 'X' })).resolves.toBeUndefined();
      expect(registryReads()).toBe(0);
    });

    it('SUPER-ADMIN (pattern *) writes pass with ZERO reads — though NOT the owner', async () => {
      const pid = uuid();
      using su = await makeClient({ instanceName: 'nebula-platform', activeScope: 'nebula-platform', isAdmin: true, profileId: uuid() });
      await expect(write(su, pid, { name: 'X' })).resolves.toBeUndefined();
      expect(registryReads()).toBe(0);
    });

    it('NON-admin NON-owner is rejected with ZERO reads', async () => {
      const pid = uuid();
      using stranger = await makeClient({ isAdmin: false, profileId: uuid() });
      await expect(write(stranger, pid, { name: 'X' })).rejects.toThrow(/owner or admin/i);
      expect(registryReads()).toBe(0);
    });

    it('SCOPED-admin covering the profile scope passes — with EXACTLY ONE read (positive control)', async () => {
      const pid = uuid();
      await seedIdentity(pid, 'acme.app.tenant');
      using admin = await makeClient({ instanceName: 'acme', activeScope: 'acme', isAdmin: true, profileId: uuid() }); // pattern acme.*
      await expect(write(admin, pid, { name: 'X' })).resolves.toBeUndefined();
      expect(registryReads()).toBe(1);                              // proves the counter is genuinely wired (not vacuous)
    });

    // ⏳ SKIPPED — this asserts ADR-012's committed TARGET, which the code has not reached yet.
    // ADR-012 retires the scoped-admin branch (`requireOwnerOrAdmin` qualifies owner + super-admin
    // ONLY), but the branch is still live: `#requireOwnerOrAdmin` step (4) + `lookupProfileScopes`.
    // BLOCKER: tasks/nebula-auth-identity-mint.md §4 *Drop the Profile's scoped-admin branch*.
    // Un-skipping is that section's acceptance criterion — and it also DELETES the positive control
    // above and the fail-closed test below, whose whole subject is the branch being removed.
    //
    // ⚠️ Asserts only what ADR-012 + §4 have PINNED: refusal, and zero registry reads (§4's stated
    // consequence — the branch is the file's one read, and removing it leaves `getScopesForProfile`
    // unused for authz). The rejection MESSAGE is deliberately unasserted: §4 does not pin one, and
    // guessing it here would make this a scaffold rather than a contract (testing.md).
    it.skip('SCOPED-admin covering the profile scope is REFUSED — owner + super-admin ONLY (ADR-012)', async () => {
      const pid = uuid();
      await seedIdentity(pid, 'acme.app.tenant');
      using admin = await makeClient({ instanceName: 'acme', activeScope: 'acme', isAdmin: true, profileId: uuid() }); // pattern acme.*
      await expect(write(admin, pid, { name: 'X' })).rejects.toThrow();
      await expect(readNotes(admin, pid)).rejects.toThrow();
      expect(registryReads()).toBe(0);                              // branch gone → the ONE read goes with it
    });

    it('SCOPED-admin covering NONE of the profile scopes is rejected (cross-Galaxy admin) — one read, then deny', async () => {
      const pid = uuid();
      await seedIdentity(pid, 'acme.app.tenant');
      using admin = await makeClient({ instanceName: 'other-universe', activeScope: 'other-universe', isAdmin: true, profileId: uuid() });
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

      using stranger = await makeClient({ isAdmin: false, profileId: uuid() });
      await expect(read(stranger, pid)).resolves.toBeDefined();             // CAN read public fields (open)...
      await expect(readNotes(stranger, pid)).rejects.toThrow(/owner or admin/i); // ...but NOT the blob
    });
  });

  it('fail-closed: a scoped-admin whose registry read THROWS is DENIED, never allowed (#8)', async () => {
    // ProfileTest.lookupProfileScopes throws for FAIL_CLOSED_PROFILE_ID → #requireOwnerOrAdmin must catch + deny.
    using admin = await makeClient({ instanceName: 'acme', activeScope: 'acme', isAdmin: true, profileId: uuid() });
    await expect(write(admin, FAIL_CLOSED_PROFILE_ID, { name: 'X' })).rejects.toThrow(/authz check failed/i);
  });

  // ── A NARROWER token is never an OWNER (tasks/archive/nebula-mint-narrower-token.md Phase 3) ────────────
  // ⚠️ **This test is ADR-009 RUNG 2 and does NOT inherit this file's rung-3 header.** The whole
  // point is the token minted by the production `/mint-narrower-token` endpoint, so the principals
  // are a real founder and a real invited member, and the token under test comes from the endpoint
  // via the production client capability, `admin.impersonate()`. (It was labelled rung 1 before
  // Phase 4 of tasks/archive/nebula-impersonation-client.md; that was wrong — rung 1 is the real email
  // transport, which the `baseline` lane does not use.)
  //
  // Independent of ADR-012's pending amendment: with a NON-admin subject the mirrored `admin` bit is
  // absent, so `#requireOwnerOrAdmin` branch (2) rejects and branch (4) is never reached — the only
  // thing that can let this through is the owner branch, which is exactly what `!claims.act` closes.
  it('a NARROWER token is NOT the owner — the admin driving it can neither write nor read privateNotes', async () => {
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

    using impersonating = await admin.impersonate(member.sub, star);
    await vi.waitFor(() => expect(impersonating.connectionState).toBe('connected'));
    // Fixture guards. The token carries the SUBJECT's `profileId` — so the owner branch's zero-read
    // equality DOES match, and `!claims.act` is the only thing standing between it and ownership.
    expect(impersonating.claims.profileId).toBe(pid);
    expect(impersonating.claims.act?.sub).toBeDefined();
    expect(impersonating.claims.access.admin).toBeUndefined(); // non-admin subject → branch (2) rejects

    // Mutation: drop `!claims.act` from the owner branch → both of these succeed → this reds.
    await expect(write(impersonating, pid, { name: 'X' })).rejects.toThrow(/owner or admin/i);
    await expect(readNotes(impersonating, pid)).rejects.toThrow(/owner or admin/i);

    // Control: the member's OWN login (same `profileId`, no `act`) IS the owner — proving the denial
    // above is the `act` clause and not a broken fixture or an unreachable DO.
    //
    // ⚠️ **This one deliberately does NOT use `impersonate()`, and cannot.** Every token that method
    // mints carries `act`, which is precisely the clause under test — so an impersonated "control"
    // would assert a DENIAL, and a builder chasing its red would be one edit from deleting the
    // `!claims.act` guard this test exists to protect. It is a real cookie-login client instead.
    await expect(write(ownerClient, pid, { name: 'X' })).resolves.toBeUndefined();

    // Every other client in this file is `using`-scoped; these two are plain consts because
    // `impersonate()` needs a live parent. Dispose explicitly so they do not hold Gateway sockets
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
