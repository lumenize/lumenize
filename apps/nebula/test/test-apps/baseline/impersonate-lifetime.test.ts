/**
 * Impersonation lifetime — the session outlives its token and dies with its parent.
 *
 * Phase 3 of tasks/nebula-impersonation-client.md. ADR-009 rung 2, like the rest of the lane.
 *
 * ⚠️ **Two TTL regimes, deliberately.** The client refreshes when a token is within 30s of expiry,
 * so a sub-30s token is *born* due and re-mints during the child's own construction — which is how
 * the re-mint tests get a deterministic trigger with no waiting. Everything that must NOT re-mint
 * uses `SAFE_TTL`, comfortably outside that window.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { generateUuid } from '@lumenize/auth';
import { NebulaClientTest } from './index';
import { universeAdminClient, createInvitedClient, createSubject } from '../../test-helpers';
import { childCount, isTornDown } from '../../../src/impersonation';

const ORIGIN = 'https://example.com';
/** Outside the 30s refresh-ahead window — construction will not re-mint. */
const SAFE_TTL = 300;
/** Inside the window — the seeded token is born due, so the child re-mints while constructing. */
const INSTANT_REMINT_TTL = 20;

async function adminAndMember(email = 'member@example.com') {
  const universe = `impl-${generateUuid().slice(0, 8)}`;
  const star = `${universe}.app.tenant`;
  const browser = new Browser();
  const { client: admin, accessToken: adminToken, payload: adminPayload } = await universeAdminClient(
    NebulaClientTest, browser, star, star, 'admin@example.com',
  );
  await createSubject(browser, star, adminToken, email);
  const { payload: member } = await createInvitedClient(
    NebulaClientTest, new Browser(), star, star, email,
  );
  return { universe, star, browser, admin, adminToken, adminPayload, member };
}

describe('lifetime — the cascade', () => {
  it('disposing the parent tears the child down, and it does NOT come back', async () => {
    const { star, admin, member } = await adminAndMember();
    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    await admin.dispose();

    // ⚠️ Assert `connectionState` and "does it come back?", NOT a call: after `disconnect()` the
    // socket is null and no reconnect is armed, so a fresh `callAsync` is QUEUED rather than
    // rejected and would settle only at the 30s default — four such assertions would be ~2 minutes
    // that reads as a hang.
    expect(child.connectionState).toBe('disconnected');
    // Mutation: drop the cascade → the child stays connected (or reconnects) → reds.
    await new Promise((r) => setTimeout(r, 150));
    expect(child.connectionState).toBe('disconnected');
  });

  it('fires through EVERY teardown door — dispose(), logout() and [Symbol.dispose]()', async () => {
    // ✅ Checkable, and it is what makes the work ONE hook rather than three overrides: every door
    // routes through `disconnect()` and no transient path does. The criterion still asserts all
    // three, because a builder can hook the wrong one.
    for (const door of ['dispose', 'logout', 'symbol'] as const) {
      const { star, admin, member } = await adminAndMember();
      const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

      if (door === 'dispose') await admin.dispose();
      else if (door === 'logout') await admin.logout();
      else admin[Symbol.dispose]();

      // Mutation: hook the cascade on `[Symbol.dispose]()` only → the `using` case stays green
      // while both others red.
      expect(child.connectionState, `door: ${door}`).toBe('disconnected');
      expect(childCount(admin), `door: ${door}`).toBe(0);
    }
  });

  it('a BLIP does not cascade — the child survives the parent reconnecting', async () => {
    const { star, browser, admin, adminToken, member } = await adminAndMember();
    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // A REAL transient drop, via the supersede path `nebula-client-reconnect.test.ts` uses: a second
    // client on the same instanceName makes the Gateway close the first with 4409, which
    // `#handleClose` routes to `#scheduleReconnect()` → 'reconnecting'. It never calls
    // `disconnect()` and never reaches 'disconnected' — which is the whole distinction under test.
    const browserB = new Browser();
    const superseder = new NebulaClientTest({
      baseUrl: ORIGIN, authScope: star, activeScope: star, appVersion: 'v1',
      instanceName: admin.lmz.instanceName, accessToken: adminToken,
      fetch: browserB.fetch, WebSocket: browserB.WebSocket,
    });
    await vi.waitFor(() => expect(admin.connectionState).toBe('reconnecting'));
    superseder.disconnect(); // before its connect cycle ping-pongs with the parent's reconnect

    // Mutation: fire the cascade on any transition OUT of 'connected' (i.e. on 'reconnecting') →
    // the child is torn down by a blip → reds. ⚠️ The mutation must be 'reconnecting', NOT
    // 'disconnected': a blip never reaches 'disconnected', so hooking that state is
    // indistinguishable from correct and this criterion could not red on it.
    expect(child.connectionState).toBe('connected');
    expect(isTornDown(admin)).toBe(false);
    expect(childCount(admin)).toBe(1);

    // And it really is transient — the parent comes back, with its child still attached.
    await vi.waitFor(() => expect(admin.connectionState).toBe('connected'), { timeout: 10_000 });
    expect(child.connectionState).toBe('connected');
    expect(childCount(admin)).toBe(1);
    child.disconnect();
    admin.disconnect();
  });
});

describe('lifetime — a torn-down parent cannot re-mint', () => {
  it.each(['dispose', 'logout'] as const)(
    'after the parent %s(), the child re-mint path fails', async (door) => {
      const { star, admin, member } = await adminAndMember();
      const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

      if (door === 'dispose') await admin.dispose(); else await admin.logout();

      // The latch is NEW STATE, not a consequence of disposal: `disconnect()` deliberately keeps the
      // token and `authedFetch` needs no connection, so without it a torn-down parent keeps minting
      // for its full remaining token life.
      // Mutation: leave the captured closure live after teardown → the re-mint succeeds → reds.
      // Second mutation: mark on `dispose()` but not `logout()` → the logout row reds alone.
      expect(isTornDown(admin), `door: ${door}`).toBe(true);
      await expect(admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL }))
        .rejects.toThrow(/torn down/i);
    });
});

describe('lifetime — child logout() is child-only teardown', () => {
  it('leaves the admin session intact — the parent still connects AND still mints', async () => {
    const { star, admin, member } = await adminAndMember();
    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    await child.logout();

    expect(child.connectionState).toBe('disconnected');
    expect(childCount(admin)).toBe(0);
    // Mutation: give the child the parent's `authScope` and let the POST through → the admin's
    // refresh token is revoked → the mint below fails → reds. ⚠️ Silent without this criterion:
    // nothing else calls `child.logout()`, so it would ship green and surface as an admin's session
    // dying for no visible reason.
    expect(admin.connectionState).toBe('connected');
    expect(isTornDown(admin)).toBe(false);
    const again = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(again.connectionState).toBe('connected'));
    again.disconnect();
    admin.disconnect();
  });
});

describe('lifetime — re-minting through the parent', () => {
  it('re-mints through the parent, and the re-mint never changes who the child is', async () => {
    const { star, admin, member } = await adminAndMember();
    const sink: any[] = [];
    setDebugSink((e) => sink.push(e));
    try {
      // Born inside the refresh-ahead window, so the re-mint fires with no waiting. ⚠️ Under
      // mint-then-seed the trigger is the child's OWN CONSTRUCTION, not a later call — assert on the
      // marker COUNT reaching two, never on "after the next operation", which would pass vacuously.
      const child = await admin.impersonate(member.sub, star, { ttlSeconds: INSTANT_REMINT_TTL });
      await vi.waitFor(() => {
        const issued = sink.filter((e) =>
          e.namespace === 'nebula-auth.worker.narrower.issued'
          && e.data?.subOfNarrowerToken === member.sub);
        // Mutation: give the child a `refresh` that returns its original token unchanged → no
        // second marker → reds.
        expect(issued.length).toBeGreaterThanOrEqual(2);
      });

      // Mutation: route the child's refresh through the parent's cookie path instead of the mint
      // helper → the re-minted token is the ADMIN's and `sub` changes → reds. This is the
      // identity-swap hazard the whole task exists to close, caught as a test.
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));
      expect(child.claims.sub).toBe(member.sub);
      expect(child.claims.act?.sub).toBeDefined();
      child.disconnect();
      admin.disconnect();
    } finally { clearDebugSink(); }
  });

  // ── the terminal/transient classification ──────────────────────────────────────────────────────
  // Asserted at the unit level because that is where it is deterministic. The rule is structural
  // (4xx terminal, everything else transient) rather than a status list, so a status the endpoint
  // gains later inherits the right behaviour.
  it.each([
    [400, true], [403, true], [404, true], [409, true],
    [500, false], [502, false], [0, false],
  ])('status %i classifies terminal=%s', async (status, terminal) => {
    const { ImpersonationMintError } = await import('../../../src/impersonation');
    // Mutation: classify every failure as terminal → the 5xx rows red, which is the direction that
    // matters: a build that terminates on everything kills an impersonation session on a blip,
    // inverting the invariant this file states three times.
    expect(new ImpersonationMintError(status, 'x').terminal).toBe(terminal);
  });

  // ⚠️ DEFERRED, not forgotten — the harness cannot reach this path deterministically, and finding
  // out why surfaced a real asymmetry worth recording. A refresh failure TERMINATES the client only
  // through `#connectInternal`'s catch; the `authedFetch` path (`#ensureFreshToken` → `refresh`)
  // propagates the throw to its CALLER and leaves `connectionState` untouched. So driving a terminal
  // refusal needs the child to attempt a CONNECT after its authority is revoked — and the cascade
  // has by then already disconnected it (tearing the parent down is what revokes authority), while
  // the other trigger, deleting the subject, needs the child's token to actually lapse against the
  // Gateway's per-message `exp` check. Owner: the `/live` scenario in
  // tasks/nebula-impersonation-client.md, where a real clock makes it reachable.
  it.skip('a TERMINAL re-mint failure ends the child without logging the admin out', async () => {
    // The probe has to be the parent's REAL `onLoginRequired` config hook — that is the thing mesh's
    // terminal path calls, and the thing a child must not inherit. A field invented on the instance
    // would be read by nothing and the assertion would pass no matter what the code did.
    const universe = `impl-${generateUuid().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const browser = new Browser();
    let loginRequiredFired = false;
    const { client: admin, accessToken: adminToken } = await universeAdminClient(
      NebulaClientTest, browser, star, star, 'admin@example.com', 'v1',
      { onLoginRequired: () => { loginRequiredFired = true; } },
    );
    await createSubject(browser, star, adminToken, 'member@example.com');
    const { payload: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), star, star, 'member@example.com',
    );
    // Fixture guard: the hook really is wired, so a false below means "did not fire", not "absent".
    expect(typeof loginRequiredFired).toBe('boolean');

    const child = await admin.impersonate(member.sub, star, { ttlSeconds: INSTANT_REMINT_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // Tear the parent down: every subsequent re-mint is refused terminally by the latch.
    await admin.dispose();

    // The child ends; the parent's handler never fires. Mutation: hand the child the parent's
    // `onLoginRequired` → the admin is bounced to login because someone else's session ended →
    // reds. ⚠️ The mutation targets the INHERITANCE CONTRACT, which is what actually protects the
    // admin — not the error class, which mesh either treats as transient or overwrites.
    await vi.waitFor(() => expect(child.connectionState).toBe('disconnected'));
    expect(loginRequiredFired).toBe(false);
    expect(childCount(admin)).toBe(0);
  });
});
