/**
 * Shared test helpers for Nebula test files.
 *
 * Composes nebula-auth test mode login with NebulaClient creation.
 */
import { expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid, parseJwtUnsafe } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import type { NebulaClient, NebulaClientConfig } from '@lumenize/nebula';
import { requestUniverseClaim, requestMagicLink } from './lib/email-login';

const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'
export const ORIGIN = 'http://localhost';

function authUrl(path: string): string {
  return `${ORIGIN}${PREFIX}/${path}`;
}

/**
 * A unique 3-segment star id (`<universe>.app.tenant`) for claim-sensitive
 * tests. Each call yields a fresh universe so distinct `it` blocks never share
 * a Star/Galaxy/Universe DO instance (the "isolation flips the result"
 * footgun — see testing.md). `star == authScope == activeScope`, so it can mint
 * exactly one star-level `aud`; it cannot produce two sibling stars under one
 * galaxy (use `uniqueGalaxyScope()` for that).
 */
export function uniqueStar(): string {
  return `s-${generateUuid().slice(0, 8)}.app.tenant`;
}

/**
 * A unique galaxy plus two sibling stars beneath it — the fixture for the
 * shared-Galaxy multi-star scenario. `starA`/`starB` share one Galaxy DO
 * (`galaxy`), which is exactly the collision under test; across `it` blocks the
 * galaxy id is unique so suites don't cross-pollute.
 */
export function uniqueGalaxyScope(): {
  universe: string;
  galaxy: string;
  starA: string;
  starB: string;
  /** The reserved dev-sandbox Star under this galaxy (`{u}.{g}.dev`). A plain `Star`
   *  at a `.dev` instance (Decision 2 — no DevStar class/binding); shares the Galaxy
   *  DO with `starA`/`starB`. See tasks/nebula-studio.md § Dev-data reset. */
  dev: string;
} {
  const universe = `g-${generateUuid().slice(0, 8)}`;
  const galaxy = `${universe}.app`;
  return {
    universe,
    galaxy,
    starA: `${galaxy}.tenant-a`,
    starB: `${galaxy}.tenant-b`,
    dev: `${galaxy}.dev`,
  };
}

/**
 * The universe segment of any scope id (`a.b.c` → `a`). The universe is the only tier
 * `claim-universe` accepts (`isValidSlug` rejects dots), and therefore the only tier at
 * which a *founder admin* identity can be minted.
 */
export function universeOf(scope: string): string {
  return scope.split('.')[0];
}

/**
 * Claim a universe — the **only open founder-minting path** (`#mintIdentity(..., isAdmin: true)`).
 * Returns the test-mode magic-link URL.
 *
 * ⚠️ Login NEVER mints. `requestMagicLink` creates a link for any email, but consuming it fails
 * unless an `Identities` row already exists (`getAndVerifyIdentity` → no row → reject). So an
 * identity must be established here (founder) or via `createSubject` (invite) *before* any login.
 */
export async function claimUniverse(
  browser: Browser,
  universe: string,
  email: string,
): Promise<string | null> {
  // Delegates to the vitest-free core in ./lib/email-login so the Node harness and these
  // vitest helpers can't drift apart on endpoint shape or 409 semantics. The 409 rule lives
  // there: slug already claimed → null, so the caller falls through to an ordinary login.
  const magicLinkUrl = await requestUniverseClaim({
    baseUrl: ORIGIN, universe, email, fetchImpl: browser.fetch,
  });
  if (magicLinkUrl === null) return null;
  expect(magicLinkUrl).toBeDefined();
  return magicLinkUrl!;
}

/**
 * Establish a founder admin for `scope`'s universe and capture its refresh cookie.
 *
 * ⚠️ **The cookie lands at `/auth/{universe}`, not `/auth/{scope}`** — cookie paths are
 * RFC-6265 matched (`@lumenize/testing` `cookieMatches`), and `/auth/acme` does NOT match
 * `/auth/acme.app.tenant`. So every later refresh for this identity must target the
 * **universe** auth scope; only `activeScope` varies down the hierarchy (`{u}.*` covers it).
 */
export async function bootstrapAdmin(
  browser: Browser,
  scope: string,
  email: string,
): Promise<void> {
  const universe = universeOf(scope);
  const claimLink = await claimUniverse(browser, universe, email);
  if (claimLink) {
    // Click magic link — browser captures Set-Cookie at Path=/auth/{universe}
    await browser.fetch(claimLink);
    return;
  }
  // Already claimed (this founder backing a second client, or a second Browser for the same
  // identity) — request a fresh login link for the existing identity and click that instead.
  const magicLinkUrl = await requestMagicLink({
    baseUrl: ORIGIN, authScope: universe, email, fetchImpl: browser.fetch,
  });
  expect(magicLinkUrl).toBeDefined();
  await browser.fetch(magicLinkUrl!);
}

/**
 * Create a subject via admin invite + magic link flow.
 * Uses NebulaAuth's POST /invite endpoint with { emails: [...] } body.
 */
export async function createSubject(
  browser: Browser,
  authScope: string,
  adminAccessToken: string,
  email: string,
  options: { isAdmin?: boolean } = {},
): Promise<void> {
  // Admin invites the user via POST /auth/{scope}/invite?_test=true
  const inviteResp = await browser.fetch(authUrl(`${authScope}/invite?_test=true`), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ emails: [email] }),
  });
  expect(inviteResp.status).toBe(200);

  // User clicks magic link (the invite already created the subject,
  // but the user still needs to verify via magic link)
  const mlResp = await browser.fetch(authUrl(`${authScope}/email-magic-link?_test=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magicLinkUrl } = await mlResp.json() as any;
  await browser.fetch(magicLinkUrl);
}

/**
 * Refresh to get an access token for a given auth scope and active scope.
 * Requires a valid refresh cookie in the browser for that auth scope.
 */
export async function refreshToken(
  browser: Browser,
  authScope: string,
  activeScope: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  const refreshResp = await browser.fetch(authUrl(`${authScope}/refresh-token`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope }),
  });
  expect(refreshResp.status).toBe(200);
  const { access_token, sub } = await refreshResp.json() as any;
  expect(access_token).toBeDefined();

  const { payload } = parseJwtUnsafe(access_token)!;
  return { accessToken: access_token, payload: payload as unknown as NebulaJwtPayload };
}

/**
 * Log in an **already-minted** identity at `authScope` (request link → click → refresh).
 *
 * ⚠️ The identity must already exist at `authScope` — login never mints. Use this for an
 * **invited member** (`createSubject` minted them at that scope). For a founder admin use
 * {@link foundAndLogin}, which claims the universe first.
 */
export async function browserLogin(
  browser: Browser,
  authScope: string,
  email: string,
  activeScope?: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  // Request the magic link. Test mode is decided ENTIRELY by the `NEBULA_AUTH_TEST_MODE`
  // binding — there is no per-request opt-in here, so no `?_test=true`.
  //
  // ⚠️ Don't copy that param over from `@lumenize/auth`, where it IS load-bearing:
  // `lumenize-auth.ts` gates on `#isTestMode && searchParams.get('_test') === 'true'`, so the
  // binding alone does nothing there. nebula-auth can't do the same because the decision is
  // made inside the registry DO, reached by RPC with no request URL to read. Consequence worth
  // knowing: a leaked `NEBULA_AUTH_TEST_MODE` in a deployed worker would return magic links to
  // ORDINARY traffic, where the same leak in @lumenize/auth would only affect requests that
  // deliberately asked. The control that actually holds this line is `audit-test-mode.sh`.
  const magicLinkUrl = await requestMagicLink({
    baseUrl: ORIGIN, authScope, email, fetchImpl: browser.fetch,
  });
  expect(magicLinkUrl).toBeDefined();

  // Click magic link — browser captures Set-Cookie with path scope
  await browser.fetch(magicLinkUrl!);

  // Refresh to get JWT
  return refreshToken(browser, authScope, activeScope ?? authScope);
}

/**
 * Found a universe and log its admin in: claim (mints the founder, `isAdmin: true`) → click →
 * refresh. The founder-admin counterpart to {@link browserLogin}.
 *
 * `scope` is the **hierarchy** you want to authenticate within — its universe is what gets
 * claimed and what the refresh cookie is scoped to. `activeScope` (defaulting to `scope`) is the
 * JWT `aud`; it may be any descendant, since the founder's pattern is `{universe}.*`.
 *
 * Returns the `authScope` actually used (the universe) so callers can configure a client with it.
 */
export async function foundAndLogin(
  browser: Browser,
  scope: string,
  email: string,
  activeScope?: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload; authScope: string }> {
  const universe = universeOf(scope);
  await bootstrapAdmin(browser, universe, email);
  const { accessToken, payload } = await refreshToken(browser, universe, activeScope ?? scope);
  return { accessToken, payload, authScope: universe };
}

/** Build + connect a client over an already-established refresh cookie. Shared by both factories. */
async function connectClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  authScope: string,
  activeScope: string,
  appVersion: string,
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<T> {
  const ctx = browser.context(ORIGIN);
  const client = new ClientClass({
    baseUrl: ORIGIN,
    authScope,
    activeScope,
    appVersion,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
    ...extraConfig,
  });
  // Wait for connection. Baseline-project setup file bumps vi.waitFor's
  // default timeout to 5s (apps/nebula/test/test-apps/baseline/test/setup.ts).
  await vi.waitFor(() => {
    expect(client.connectionState).toBe('connected');
  });
  return client;
}

/**
 * **An admin that legitimately governs `scope`** — the default choice.
 *
 * Says WHAT THE TEST NEEDS, not what the auth layer happens to mint. Use this whenever the test
 * just needs "an authenticated admin who can operate here" and does **not** depend on the admin's
 * tier or pattern shape.
 *
 * 🔒 **STAR-TIER ONLY.** `scope` must be 3 segments; anything else throws. A non-star caller is
 * asking for a wildcard admin whether it says so or not, and must say so — use
 * {@link universeAdminClient}.
 *
 * That refusal is deliberately a runtime precondition and not a grep: all 78 call sites pass
 * *identifiers*, never dotted literals, and several pass a wrapper parameter whose segment count
 * lives two indirections away, so no static sweep can find the tier-mismatched ones. This throws on
 * exactly those, and keeps throwing on any that get added later.
 *
 * 🔶 **INTERIM — today this still mints a UNIVERSE admin (`{u}.*`) even for a star.**
 * [nebula-star-founder-provisioning.md](../../../tasks/nebula-star-founder-provisioning.md) Phase 4
 * retires that: a star scope will yield a real **star founder** with an **exact-star** pattern,
 * inert above its own Star. **When it lands, only this function body changes**, not the call sites —
 * which is the entire reason for the split, and why the precondition above has to hold first (a body
 * minting an exact-star founder cannot serve a galaxy or universe `scope` at all).
 *
 * ⚠️ If your assertion depends on the pattern being a wildcard (cross-tier reach, `{u}.*` widening,
 * "an admin with no DAG grant on this node"), you want {@link universeAdminClient} — this one's
 * guarantee will change under you.
 */
export async function adminClientAt<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  scope: string,
  activeScope: string,
  email: string,
  appVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  if (scope.split('.').length !== 3) {
    throw new Error(
      `adminClientAt is star-tier only — got "${scope}". Use universeAdminClient for a galaxy or ` +
      'universe scope (it guarantees the `{u}.*` wildcard your assertion depends on).',
    );
  }
  return createAuthenticatedClient(ClientClass, browser, scope, activeScope, email, appVersion, extraConfig);
}

/**
 * **Specifically a universe-tier admin** (`authScopePattern` = `{u}.*`), whatever `activeScope` is.
 *
 * Use this — and *only* this — when the assertion depends on the wildcard: cross-tier reach (aud at
 * one tier, callee at another), `{u}.*` widening, or "an admin with no DAG grant on this node".
 * Unlike {@link adminClientAt}, this guarantee is **stable** across the star-founder change, so
 * these fixtures keep testing the same property.
 *
 * `scope` may be any tier — the universe is derived from it.
 */
export async function universeAdminClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  scope: string,
  activeScope: string,
  email: string,
  appVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  return createAuthenticatedClient(ClientClass, browser, scope, activeScope, email, appVersion, extraConfig);
}

/**
 * Create an authenticated **founder-admin** NebulaClient and wait for it to connect.
 *
 * ⚠️ **Prefer {@link adminClientAt} or {@link universeAdminClient}** — they encode INTENT (what the
 * test needs) rather than PROVENANCE (how the identity was minted), so the star-founder change
 * touches one helper body instead of every call site. This remains the shared implementation both
 * delegate to, and the right choice only where the founder-mint mechanics are themselves the
 * subject.
 *
 * Each test-app passes its own client class (e.g., NebulaClientTest).
 *
 * `scope` is the **hierarchy** to authenticate within: its universe is claimed (minting a founder
 * with `isAdmin: true` and pattern `{universe}.*`) and becomes the client's `authScope`, because
 * that is where the refresh cookie is path-scoped. `activeScope` is the JWT `aud` — any descendant
 * of that universe. ⚠️ **The client's `authScope` is therefore the universe, not `scope`** — passing
 * a star as `scope` still yields a client whose cookie/refresh live at the universe. That is not a
 * convenience; it is the only shape RFC-6265 cookie paths permit (see {@link bootstrapAdmin}).
 *
 * For an **invited member** (no admin, minted at a non-universe scope by `createSubject`) use
 * {@link createInvitedClient} instead — this factory would mint them a *second*, admin identity.
 *
 * `appVersion` defaults to `'v1'` (matches `ONTOLOGY_VERSION` in
 * `star-resources.test.ts` and similar). Tests that bind to a different
 * ontology pass their own value. Tests that don't use `client.resources.*`
 * at all are unaffected by the default — only the auto-attach paths use it.
 */
export async function createAuthenticatedClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  scope: string,
  activeScope: string,
  email: string,
  appVersion: string = 'v1',
  /** Optional extra config to pass through to the client constructor —
   *  e.g. `{ onShouldRefreshUI: fn }` for Phase 5.3.3d staleness tests. */
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  const { accessToken, payload, authScope } = await foundAndLogin(browser, scope, email, activeScope);
  const client = await connectClient(ClientClass, browser, authScope, activeScope, appVersion, extraConfig);
  return { client, payload, accessToken };
}

/**
 * Mint a **narrowed** admin token through the production `/delegated-token` endpoint.
 *
 * The gate there is an UPPER bound only (`matchAccess(caller.authScopePattern, activeScope)`), so a
 * caller may request any scope *at or below* its own reach; the mint then binds the new token to the
 * REQUESTED scope (`buildAuthScopePattern(activeScope)`), not the caller's. That is the intended
 * least-privilege delegation — and it is also the one production path that yields a **sub-universe
 * admin** today, which is exactly the principal the `access.admin` confinement is about.
 *
 * ADR-009 rung 1–2: real issuance through the real endpoint, no test-mode client mint.
 */
export async function mintDelegatedToken(
  browser: Browser,
  callerAuthScope: string,
  callerAccessToken: string,
  actFor: string,
  activeScope: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  const resp = await browser.fetch(authUrl(`${callerAuthScope}/delegated-token`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${callerAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actFor, activeScope }),
  });
  expect(resp.status).toBe(200);
  const { access_token } = await resp.json() as any;
  expect(access_token).toBeDefined();
  const { payload } = parseJwtUnsafe(access_token)!;
  return { accessToken: access_token, payload: payload as unknown as NebulaJwtPayload };
}

/** The reserved platform scope, and the bootstrap email bound in `vitest.config.js` miniflare.bindings. */
export const PLATFORM_SCOPE = 'nebula-platform';
export const BOOTSTRAP_EMAIL = 'bootstrap-admin@example.com';

/**
 * Log in the configured **platform bootstrap admin** (`authScopePattern: '*'`) at `activeScope`.
 *
 * This is the ONE production path to a *second* `access.admin` identity in a universe that already
 * has a founder: `requestMagicLink` mints the bootstrap email at `nebula-platform`
 * (`nebula-auth-registry.ts` — the only email-magic-link mint), and `*` covers every scope. Because
 * the founder's `__nebula_rootAdminSeeded` latch is already set, this identity receives **no root
 * DAG grant** — which is exactly the shape the D16 stored-bypass fixtures need ("`access.admin`
 * with no DAG grant of its own").
 *
 * ⚠️ Only usable where `NEBULA_AUTH_BOOTSTRAP_EMAIL` is bound (baseline project). Without it, login
 * succeeds but the first authed route 403s.
 */
export async function createPlatformAdminClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  activeScope: string,
  appVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  const { accessToken, payload } = await browserLogin(browser, PLATFORM_SCOPE, BOOTSTRAP_EMAIL, activeScope);
  const client = await connectClient(ClientClass, browser, PLATFORM_SCOPE, activeScope, appVersion, extraConfig);
  return { client, payload, accessToken };
}

/**
 * Create an authenticated client for an **already-minted, non-founder** identity — the invitee
 * half of the pair with {@link createAuthenticatedClient}. `authScope` is where the invite minted
 * them (`createSubject`'s scope), which is also where their refresh cookie is path-scoped.
 */
export async function createInvitedClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  authScope: string,
  activeScope: string,
  email: string,
  appVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  const { accessToken, payload } = await browserLogin(browser, authScope, email, activeScope);
  const client = await connectClient(ClientClass, browser, authScope, activeScope, appVersion, extraConfig);
  return { client, payload, accessToken };
}
