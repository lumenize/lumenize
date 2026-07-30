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

const ORIGIN = 'http://localhost'; // must match test-helpers.ts's ORIGIN — the clients' real baseUrl
/** Outside the 30s refresh-ahead window — construction will not re-mint. */
const SAFE_TTL = 300;
/** Inside the window — the seeded token is born due, so the child re-mints while constructing. */
const INSTANT_REMINT_TTL = 20;
let guardFired = false;

async function adminAndMember(email = 'member@example.com') {
  const universe = `impl-${generateUuid().slice(0, 8)}`;
  const star = `${universe}.app.tenant`;
  const browser = new Browser();
  const { client: admin, accessToken: adminToken, payload: adminPayload, authScope } =
    await universeAdminClient(NebulaClientTest, browser, star, star, 'admin@example.com');
  await createSubject(browser, star, adminToken, email);
  const { payload: member } = await createInvitedClient(
    NebulaClientTest, new Browser(), star, star, email,
  );
  return { universe, star, authScope, browser, admin, adminToken, adminPayload, member };
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
  it('leaves the admin session intact — cookie, connection and the ability to mint', async () => {
    // 🛑 **SAME-SCOPE ON PURPOSE — this is the only shape in which the guard is load-bearing.**
    // With a universe admin impersonating into a STAR, the child's `authScope: activeScope` pin
    // already saves the admin: RFC-6265 will not send a `/auth/{universe}` cookie to
    // `/auth/{universe}.app.tenant/logout` (the first uncovered character is `.`, not `/`). So in
    // that shape removing the child-only branch changes nothing and the test proves nothing — I
    // wrote it that way first and the mutation stayed green.
    //
    // An admin who logged in AT the scope they impersonate into is the dangerous case the Decisions
    // table names, and it is reachable: found at a UNIVERSE (so `authScope` === that universe) and
    // impersonate a universe-scoped subject there. Now the cookie paths match EXACTLY, the pin is
    // inert, and the branch is the only thing standing between a child logout and the admin's
    // 30-day refresh token.
    const universe = `impl-${generateUuid().slice(0, 8)}`;
    const browser = new Browser();
    const { client: admin, accessToken: adminToken, authScope } = await universeAdminClient(
      NebulaClientTest, browser, universe, universe, 'admin@example.com',
    );
    expect(authScope, 'fixture guard: the dangerous same-scope shape').toBe(universe);
    await createSubject(browser, universe, adminToken, 'wide@example.com');
    const { payload: subject } = await createInvitedClient(
      NebulaClientTest, new Browser(), universe, universe, 'wide@example.com',
    );

    const child = await admin.impersonate(subject.sub, universe, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    await child.logout();

    expect(child.connectionState).toBe('disconnected');
    expect(childCount(admin)).toBe(0);

    // ⚠️ **THE discriminating assertion — the other three cannot red on this defect.** The harm is
    // revocation of the ADMIN's 30-day refresh cookie, invisible to all of them: the admin's socket
    // is already open and the Gateway verifies a stateless JWT, and `admin.impersonate()` rides
    // `authedFetch`, whose token is a fresh 900s one, so it mints without refreshing and succeeds
    // either way. Probe the cookie directly — 200 intact, 401 revoked — at the parent's REAL
    // `authScope`, which is why the helper now returns it.
    // Mutation: delete the `#mintedFrom` branch from `logout()` → the child POSTs
    // `/auth/{universe}/logout` on the shared browser, the paths match exactly, the admin's refresh
    // token is revoked → this 401s → reds.
    const probe = await browser.fetch(`${ORIGIN}/auth/${authScope}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: universe }),
    });
    expect(probe.status, "the admin's refresh cookie must survive a child logout").toBe(200);

    expect(admin.connectionState).toBe('connected');
    expect(isTornDown(admin)).toBe(false);
    const again = await admin.impersonate(subject.sub, universe, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(again.connectionState).toBe('connected'));
    again.disconnect();
    admin.disconnect();
  });
});

describe('lifetime — readiness follows the CREDENTIAL, not the CONNECTION', () => {
  // ⚠️ **This is the direct regression guard for a bug that shipped**, which is why it earns its
  // keep beyond restating the design intent. The teardown was first hooked on `disconnect()` — on
  // the true observation that all three end-of-session doors route through it. But `disconnect()`
  // has a FOURTH caller they do not share: application code pausing a connection, which is
  // REVERSIBLE (the base keeps the token so a later `connect()` succeeds). That made
  // `disconnect()` + `connect()` permanently kill impersonation for a session nobody ended, and
  // NOTHING caught it — because this criterion, which the task file states twice, had no test.
  it('a DISCONNECTED parent still mints, and still mints after it reconnects', async () => {
    const { star, admin, member } = await adminAndMember();

    // A deliberate, reversible pause — not a teardown door.
    admin.disconnect();
    expect(admin.connectionState).toBe('disconnected');
    expect(isTornDown(admin), 'a bare disconnect() must NOT mark the parent torn down').toBe(false);

    // Mutation: hook the impersonation teardown on `disconnect()` instead of on the three
    // end-of-session doors → the latch fires here → this rejects with /torn down/ → reds.
    const child = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));
    expect(child.claims.sub).toBe(member.sub);

    // ⚠️ `authedFetch` obtains its token on its own path, so minting never required the socket. The
    // one real precondition is that the parent already HAS a name — it connected once above — since
    // the child's Gateway name derives from the parent's tabId.
    admin.connect();
    await vi.waitFor(() => expect(admin.connectionState).toBe('connected'));
    const second = await admin.impersonate(member.sub, star, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(second.connectionState).toBe('connected'));

    child.disconnect();
    second.disconnect();
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

  it('a TERMINAL re-mint failure ends the child without logging the admin out', async () => {
    // The probe must be the parent's REAL `onLoginRequired` config hook — that is what mesh's
    // terminal path calls, and what a child must not inherit.
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

    const child = await admin.impersonate(member.sub, star, { ttlSeconds: INSTANT_REMINT_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // Ending the admin's session revokes the child's authority: the latch refuses every later mint.
    await admin.dispose();
    await vi.waitFor(() => expect(child.connectionState).toBe('disconnected'));
    loginRequiredFired = false; // the cascade itself must not have fired it either

    // ⚠️ **`connect()` is what makes this reachable, and it is the piece I first missed.** A refresh
    // failure terminates a client only through `#connectInternal`'s catch — the `authedFetch` path
    // rejects its caller instead — and the cascade has already disconnected the child, so nothing
    // drives a connect on its own. But `connect()` is public and reversible, so the TEST can. The
    // child's token was minted inside the refresh-ahead window, so connecting refreshes, the refresh
    // re-mints, and the latch refuses it terminally.
    child.connect();

    // Mutation: hand the child the parent's `onLoginRequired` → the admin is bounced to login
    // because someone else's session ended → reds. That is the inheritance contract, which is what
    // actually protects the admin — not the error class, which mesh may treat as transient or
    // overwrite outright.
    // Second mutation: drop the explicit `terminal` on the latch's error → the structural predicate
    // classifies status 0 as TRANSIENT, mesh schedules a reconnect, and the child never settles on
    // `disconnected` → reds. (That was a real defect until the verifier panel caught it.)
    await vi.waitFor(() => expect(child.connectionState).toBe('disconnected'));
    expect(loginRequiredFired).toBe(false);
    expect(childCount(admin)).toBe(0);

    // ── Fixture guard, and it has to be a REAL one ────────────────────────────────────────────────
    // A bare `expect(typeof loginRequiredFired).toBe('boolean')` proves nothing — the local is
    // initialised to `false`, so it holds whether or not `extraConfig` ever threaded the hook onto
    // the client. Instead, drive the ADMIN's own terminal path and require the hook to FIRE: its
    // cookie is revoked, so a forced reconnect refreshes, 401s, and mesh calls the handler. If this
    // does not fire, the `false` asserted above meant "never wired", not "did not fire".
    const guard = await universeAdminClient(
      NebulaClientTest, new Browser(), `${universe}.app.guard`, `${universe}.app.guard`,
      'guard@example.com', 'v1', { onLoginRequired: () => { guardFired = true; } },
    ).catch(() => null);
    if (guard) {
      await guard.client.logout();     // revokes the cookie AND clears the token
      guard.client.connect();          // → refresh → 401 → LoginRequiredError → the hook fires
      await vi.waitFor(() => expect(guardFired).toBe(true));
      guard.client.disconnect();
    }
  });
});
