/**
 * Impersonation lifetime — the session outlives its token and dies with its parent.
 *
 * Phase 3 of tasks/archive/nebula-impersonation-client.md. ADR-009 rung 2, like the rest of the lane.
 *
 * ⚠️ **Two TTL regimes, deliberately.** The client refreshes when a token is within 30s of expiry,
 * so a sub-30s token is *born* due and re-mints during the child's own construction — which is how
 * the re-mint tests get a deterministic trigger with no waiting. Everything that must NOT re-mint
 * uses `SAFE_TTL`, comfortably outside that window.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NebulaClientTest } from './index';
import { universeAdminClient, createInvitedClient, createSubject, pageOf, ORIGIN } from '../../test-helpers';
import { childrenOf, isTornDown } from '../../../src/impersonation';

/** Outside the 30s refresh-ahead window — construction will not re-mint. */
const SAFE_TTL = 300;
/** Inside the window — the seeded token is born due, so the child re-mints while constructing. */
const INSTANT_REMINT_TTL = 20;
let guardFired = false;

async function adminAndMember(email = 'member@example.com') {
  const universe = `impl-${crypto.randomUUID().slice(0, 8)}`;
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
    const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
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
      const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

      if (door === 'dispose') await admin.dispose();
      else if (door === 'logout') await admin.logout();
      else admin[Symbol.dispose]();

      // Mutation: hook the cascade on `[Symbol.dispose]()` only → the `using` case stays green
      // while both others red.
      expect(child.connectionState, `door: ${door}`).toBe('disconnected');
      expect(childrenOf(admin).length, `door: ${door}`).toBe(0);
    }
  });

  it('a BLIP does not cascade — the child survives the parent reconnecting', async () => {
    const { star, browser, admin, adminToken, member } = await adminAndMember();
    const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // A REAL transient drop, via the supersede path `nebula-client-reconnect.test.ts` uses: a second
    // client on the same instanceName makes its host node close the first with 4409, which
    // `#handleClose` routes to `#scheduleReconnect()` → 'reconnecting'. It never calls
    // `disconnect()` and never reaches 'disconnected' — which is the whole distinction under test.
    const browserB = new Browser();
    const superseder = new NebulaClientTest({
      baseUrl: pageOf(star), platformOrigin: ORIGIN, ontologyVersion: 'v1',
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
    expect(childrenOf(admin).length).toBe(1);

    // And it really is transient — the parent comes back, with its child still attached.
    await vi.waitFor(() => expect(admin.connectionState).toBe('connected'), { timeout: 10_000 });
    expect(child.connectionState).toBe('connected');
    expect(childrenOf(admin).length).toBe(1);
    child.disconnect();
    admin.disconnect();
  });
});

describe('lifetime — a torn-down parent cannot re-mint', () => {
  it.each(['dispose', 'logout'] as const)(
    'after the parent %s(), the child re-mint path fails', async (door) => {
      const { star, admin, member } = await adminAndMember();
      const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

      if (door === 'dispose') await admin.dispose(); else await admin.logout();

      // The latch is NEW STATE, not a consequence of disposal: `disconnect()` deliberately keeps the
      // token and holds a mint until the next `connect()`, so without it a torn-down parent's mint
      // would wait out its timeout and fail as transport rather than end the session.
      // Mutation: leave the captured closure live after teardown → the re-mint succeeds → reds.
      // Second mutation: mark on `dispose()` but not `logout()` → the logout row reds alone.
      expect(isTornDown(admin), `door: ${door}`).toBe(true);
      await expect(admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL }))
        .rejects.toThrow(/torn down/i);
    });
});

describe('lifetime — child logout() is child-only teardown', () => {
  it('leaves the admin session intact — no navigation, cookie, connection and the ability to mint', async () => {
    // A derived session holds no refresh cookie of its own, so its `logout()` is teardown only: the
    // `#mintedFrom` branch ends it before the code that would send a top-level page to the platform
    // host's logout page — where one click ends every session the browser holds, the admin's
    // included. Every refresh cookie sits at `Path=/` on the platform host, so nothing about the
    // scopes involved shields the admin; the branch is the control, whatever shape the pair takes.
    const universe = `impl-${crypto.randomUUID().slice(0, 8)}`;
    const browser = new Browser();
    const { client: admin, accessToken: adminToken } = await universeAdminClient(
      NebulaClientTest, browser, universe, universe, 'admin@example.com',
    );
    await createSubject(new Browser(), universe, adminToken, 'wide@example.com');
    const { payload: subject } = await createInvitedClient(
      NebulaClientTest, new Browser(), universe, universe, 'wide@example.com',
    );

    const child = await admin.impersonate(subject.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // ⚠️ **THE discriminating observable: the navigation.** Under vitest-plugin there is no `window`,
    // so the child's `logout()` would return before navigating whatever its branch did; a stubbed
    // top-level window is what lets the defect show. Mutation: delete the `#mintedFrom` branch from
    // `logout()` → the child falls through to the top-level navigation → the spy sees it → reds.
    const assign = vi.fn();
    const page = { location: { assign } } as { location: { assign: typeof assign }; top?: unknown; self?: unknown };
    page.top = page;
    page.self = page;
    vi.stubGlobal('window', page);
    try {
      await child.logout();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(assign, "a child's logout must navigate nowhere").not.toHaveBeenCalled();

    expect(child.connectionState).toBe('disconnected');
    expect(childrenOf(admin).length).toBe(0);

    // The regression guard, kept beside the navigation: the admin's cookie still mints on the
    // universe's page. Invisible to the connection assertions — the admin's socket is already open
    // and its host node accepted a stateless JWT at the upgrade.
    const probe = await browser.context(pageOf(universe)).fetch(`${ORIGIN}/auth/refresh-token`, { method: 'POST' });
    expect(probe.status, "the admin's refresh cookie must survive a child logout").toBe(200);

    expect(admin.connectionState).toBe('connected');
    expect(isTornDown(admin)).toBe(false);
    const again = await admin.impersonate(subject.sub, { ttlSeconds: SAFE_TTL });
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
  it('a PAUSED parent is not torn down: its mint waits for the reconnect, then succeeds', async () => {
    const { admin, member } = await adminAndMember();

    // A deliberate, reversible pause — not a teardown door.
    admin.disconnect();
    expect(admin.connectionState).toBe('disconnected');
    expect(isTornDown(admin), 'a bare disconnect() must NOT mark the parent torn down').toBe(false);

    // The mint rides the parent's socket, so one issued while paused waits for the reconnect. The
    // one real precondition is that the parent already HAS a name — it connected once above — since
    // the child's id derives from the parent's tabId.
    // Mutation: hook the impersonation teardown on `disconnect()` instead of on the three
    // end-of-session doors → the latch fires here → this rejects with /torn down/ → reds.
    const pending = admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
    admin.connect();
    const child = await pending;
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));
    expect(child.claims.sub).toBe(member.sub);

    // And the first mint after the reconnect, the shape the regression broke. The first child is
    // ended first: a second open child of the same subject from this tab would share its id.
    child[Symbol.dispose]();
    const second = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
    await vi.waitFor(() => expect(second.connectionState).toBe('connected'));

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
      const child = await admin.impersonate(member.sub, { ttlSeconds: INSTANT_REMINT_TTL });
      await vi.waitFor(() => {
        const issued = sink.filter((e) =>
          e.namespace === 'nebula-auth.facade.impersonate' && e.message === 'Impersonation token issued'
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

  // ⚠️ **This test exists because a claim I wrote was false.** The `/live` expiry scenario justified
  // itself with "this lane cannot let time pass", so the test above settles for a token born INSIDE
  // the refresh-ahead window — a real trigger, but one that proves the re-mint path runs rather than
  // that a session survives its token actually lapsing. Measured 2026-07-30: `vi.setSystemTime` moves
  // the clock BOTH the Worker and the DO see (a magic link consumed past `MAGIC_LINK_TTL` is rejected,
  // with an un-jumped control accepted), so a genuine expiry is reachable here after all.
  //
  // The `/live` scenario still earns its place — it runs against a clock nobody patched — but this is
  // the fast local signal that was being left on the table.
  it('survives a GENUINE expiry: the token lapses on the clock, not in the refresh-ahead window', async () => {
    const { star, admin, member } = await adminAndMember();
    const sink: any[] = [];
    setDebugSink((e) => sink.push(e));
    const issuedCount = () => sink.filter((e) =>
      e.namespace === 'nebula-auth.facade.impersonate' && e.message === 'Impersonation token issued'
      && e.data?.subOfNarrowerToken === member.sub).length;
    try {
      // SAFE_TTL, so construction does NOT re-mint — otherwise the jump below would be redundant and
      // the test would pass without the expiry ever mattering.
      const child = await admin.impersonate(member.sub, { ttlSeconds: SAFE_TTL });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'));
      expect(issuedCount(), 'precondition: exactly one mint so far').toBe(1);

      // Past the child's 300s token, but well inside the admin's 900s one — so the child MUST
      // re-mint while the parent's `authedFetch` still works. A jump past both would prove nothing
      // about which credential did the work.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date(Date.now() + (SAFE_TTL + 60) * 1000));

      // `disconnect()` is reversible and carries no teardown, so `connect()` really re-runs the
      // refresh — and now `#needsTokenRefresh()` is true because the token is genuinely past `exp`.
      child.disconnect();
      child.connect();

      // Mutation: give the child a `refresh` that returns its seeded token unchanged → no second
      // marker, and the server rejects the lapsed token → reds.
      await vi.waitFor(() => expect(issuedCount()).toBeGreaterThanOrEqual(2), { timeout: 15_000 });
      await vi.waitFor(() => expect(child.connectionState).toBe('connected'), { timeout: 15_000 });

      // Mutation: route the re-mint through the parent's cookie path → the fresh token is the
      // ADMIN's → reds. Identity preservation is the property a real lapse could silently break.
      expect(child.claims.sub).toBe(member.sub);
      expect(child.claims.act?.sub).toBeDefined();

      child.disconnect();
      admin.disconnect();
    } finally { vi.useRealTimers(); clearDebugSink(); }
  });

  // ── the terminal/transient classification ──────────────────────────────────────────────────────
  // Asserted at the unit level because that is where it is deterministic. Only the facade's typed
  // refusal is terminal; everything else a `callAsync` can reject with is transport.
  it.each([
    ['the typed refusal', Object.assign(new Error('The calling host\'s scope "u" does not administer this subject'),
      { name: 'ImpersonationRefusedError', terminal: true }), true],
    ['a disconnect', new Error('LumenizeClient disconnected before the callAsync result arrived'), false],
    ['a timeout', Object.assign(new Error('callAsync timed out'), { name: 'TimeoutError' }), false],
    ['a refusal-shaped error without `terminal`', Object.assign(new Error('x'), { name: 'ImpersonationRefusedError' }), false],
  ])('%s classifies terminal=%s', async (_label, rejection, terminal) => {
    const { mintImpersonation, ImpersonationMintError } = await import('../../../src/impersonation');
    const outcome = await mintImpersonation(() => Promise.reject(rejection), 'sub').catch((e: unknown) => e);
    // Mutation: classify every failure as terminal → the transport rows red, which is the direction
    // that matters: a build that terminates on everything kills an impersonation session on a blip.
    // Second mutation: classify the typed refusal as transient → the first row reds.
    expect(outcome instanceof ImpersonationMintError).toBe(terminal);
    if (!terminal) expect(outcome).toBe(rejection);
  });

  it('a NON-TERMINAL re-mint failure does NOT end the session', async () => {
    // The mirror of the terminal test, and the direction that actually protects a live session: a
    // build that classifies EVERY mint failure as terminal passes the terminal test and then kills
    // an impersonation session on a transient transport failure — inverting the blip invariant this file states
    // three times. testing.md requires each operand of a terminal-vs-transient condition to be
    // mutated independently rather than toggling the branch as a whole.
    // The transport failure is injected on the parent's `callAsync`, the one call the mint makes:
    // this lane cannot pause a parent at a chosen moment of a re-mint. The real paused parent is
    // driven in `/live` (`impersonation-lifecycle`), against the running system.
    const { admin, member } = await adminAndMember();
    let failMints = false;
    const realCallAsync = admin.lmz.callAsync;
    (admin.lmz as { callAsync: unknown }).callAsync = (binding: string, ...rest: unknown[]) =>
      failMints && binding === 'NEBULA_AUTH_FACADE'
        ? Promise.reject(new Error('LumenizeClient disconnected before the callAsync result arrived'))
        : (realCallAsync as (...a: unknown[]) => unknown)(binding, ...rest);

    // A token inside the refresh-ahead window, so any connect drives a re-mint.
    const child = await admin.impersonate(member.sub, { ttlSeconds: INSTANT_REMINT_TTL });
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'));

    // Now make the mint fail TRANSIENTLY, and drive a reconnect. `disconnect()` is reversible and
    // carries no teardown, so `connect()` really does re-run the refresh.
    failMints = true;
    child.disconnect();
    child.connect();

    // Mutation: classify every mint failure as terminal → the child converts to LoginRequiredError,
    // mesh sets 'disconnected' and stops → this reds, because it never returns to
    // 'reconnecting'/'connected'.
    await vi.waitFor(() => expect(child.connectionState).toBe('reconnecting'));

    // And it really is transient — the session recovers once the transport does, which is the whole
    // point of NOT ending it.
    failMints = false;
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'), { timeout: 15_000 });
    expect(child.claims.sub).toBe(member.sub);

    child.disconnect();
    admin.disconnect();
  });

  it('a TERMINAL re-mint failure ends the child without logging the admin out', async () => {
    // The probe must be the parent's REAL `onLoginRequired` config hook — that is what mesh's
    // terminal path calls, and what a child must not inherit.
    const universe = `impl-${crypto.randomUUID().slice(0, 8)}`;
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

    const child = await admin.impersonate(member.sub, { ttlSeconds: INSTANT_REMINT_TTL });
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
    // Second mutation: throw the latch's refusal as a plain Error rather than an
    // `ImpersonationMintError` → it classifies as TRANSIENT, mesh schedules a reconnect, and the
    // child never settles on `disconnected` → reds.
    await vi.waitFor(() => expect(child.connectionState).toBe('disconnected'));
    expect(loginRequiredFired).toBe(false);
    expect(childrenOf(admin).length).toBe(0);

    // ── Fixture guard, and it has to be a REAL one ────────────────────────────────────────────────
    // A bare `expect(typeof loginRequiredFired).toBe('boolean')` proves nothing — the local is
    // initialised to `false`, so it holds whether or not `extraConfig` ever threaded the hook onto
    // the client. Instead, drive a client's own terminal path through the same `extraConfig` and
    // require the hook to FIRE: its session is revoked, so a forced reconnect refreshes, 401s, and
    // mesh calls the handler. If this does not fire, the `false` asserted above meant "never wired",
    // not "did not fire". It needs a universe of its own, since `admin@example.com` holds this one.
    const guardUniverse = `implg-${crypto.randomUUID().slice(0, 8)}`;
    const guardBrowser = new Browser();
    const guard = await universeAdminClient(
      NebulaClientTest, guardBrowser, `${guardUniverse}.app.guard`, `${guardUniverse}.app.guard`,
      'guard@example.com', 'v1', { onLoginRequired: () => { guardFired = true; } },
    );
    guard.client.disconnect();
    // The platform host's logout, as its page sends it, ends the session behind every cookie it
    // receives; a client's own `logout()` in this lane only tears the client down.
    const out = await guardBrowser.context(ORIGIN).fetch(`${ORIGIN}/auth/logout`, { method: 'POST' });
    expect(out.ok).toBe(true);
    await out.text();
    // The client still holds a live access token, so a connect would not refresh. Moving the clock
    // past its lifetime (testing.md: both isolates follow it) makes the connect refresh, meet the
    // revocation, 401, and call the hook.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      guard.client.connect();
      await vi.waitFor(() => expect(guardFired).toBe(true));
    } finally {
      vi.useRealTimers();
    }
    guard.client.disconnect();
  });
});
