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
import { requestUniverseClaim, requestStarClaim, requestMagicLink } from './lib/email-login';

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
/**
 * Star slugs the platform reserves — mirrors `RESERVED_STAR_SLUGS` in `@lumenize/nebula-auth`, same
 * name on purpose. **Exactly one today: `dev`.**
 *
 * A star id's third segment is one slot holding either a tenant slug or a reserved name. The design
 * anticipates more (`staging`/`prod`) once the collapse formalizes `{u}.{g}.{env}`, but do not write
 * as if they exist — today this is "the `.dev` star", singular.
 *
 * Kept as a local copy deliberately: this guards a *fixture-choice* mistake and must throw with
 * test-authoring advice before any request is made, whereas the registry's copy is the security
 * control. Extend both together.
 */
const RESERVED_STAR_SLUGS: ReadonlySet<string> = new Set(['dev']);

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
 * Claim a tenant Star (open self-signup) and return its test-mode claim link.
 *
 * `null` on 409 — already claimed, so the caller falls through to an ordinary login. Unlike a
 * `create-star` scope that IS possible here: the claim minted an identity to log in as.
 */
export async function claimStar(
  browser: Browser,
  universeGalaxyStarId: string,
  email: string,
): Promise<string | null> {
  const magicLinkUrl = await requestStarClaim({
    baseUrl: ORIGIN, universeGalaxyStarId, email, fetchImpl: browser.fetch,
  });
  if (magicLinkUrl === null) return null;
  expect(magicLinkUrl).toBeDefined();
  return magicLinkUrl!;
}

/**
 * Found a Star **as its own founder** and capture the refresh cookie AT the star.
 *
 * The counterpart to {@link bootstrapAdmin}, and the difference is the whole point of the
 * star-founder change: this yields an **exact-star** `authScopePattern`, inert at every ancestor
 * (ADR-015), where `bootstrapAdmin` yields a universe founder whose `{u}.*` merely *covers* the star.
 *
 * ⚠️ **The cookie lands at `/auth/{star}`** — so refreshes for this identity target the star, not the
 * universe. That is only possible because `claim-star` mints an identity there; a `create-star` scope
 * has none.
 *
 * The universe and galaxy above must exist and only their own admin may create them, so those two
 * hops remain a climb — performed by a SEPARATE owner identity, since the star founder is by
 * construction a stranger to them.
 */
export async function foundStarAndLogin(
  browser: Browser,
  star: string,
  email: string,
  activeScope?: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload; authScope: string }> {
  const [universe, galaxySlug] = star.split('.');
  const galaxy = `${universe}.${galaxySlug}`;

  // 1–2. Universe + galaxy. Provisioned under the SAME email and the SAME Browser, deliberately:
  //   • same email — a separate `owner-…` identity would claim the universe first, so a later
  //     `foundAndLogin(browser, scope, email)` in the same test would find it taken and then fail to
  //     log in (that email has no universe identity). 28 tests do exactly that.
  //   • same Browser — the two cookies cannot be confused. They are Path-scoped (`/auth/{universe}`
  //     vs `/auth/{star}`) and RFC-6265 matched, so a refresh at the star sends only the star's.
  // The star identity is still its own `Identities` row at the star scope, so the minted token is
  // exact-star regardless of who owns the universe — which is the fidelity this change is about.
  await bootstrapAdmin(browser, universe, email);
  const { accessToken: ownerToken } = await refreshToken(browser, universe, universe);
  const galaxyResp = await browser.fetch(authUrl('create-galaxy'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ universeGalaxyId: galaxy }),
  });
  // 409 = already exists, which is success for provisioning purposes.
  expect([201, 409]).toContain(galaxyResp.status);

  // 3. Claim the star as the tenant — open, no admin in the loop.
  const claimLink = await claimStar(browser, star, email);
  const link = claimLink ?? (await requestMagicLink({
    baseUrl: ORIGIN, authScope: star, email, fetchImpl: browser.fetch,
  }));
  expect(link).toBeDefined();
  await browser.fetch(link!);

  const { accessToken, payload } = await refreshToken(browser, star, activeScope ?? star);
  return { accessToken, payload, authScope: star };
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
 * ✅ **Mints a REAL star founder** (2026-07-25) — `claim-star` self-signup, `authScopePattern` =
 * the exact star id, inert at every ancestor (ADR-015). It used to hand back a universe admin
 * (`{u}.*`) regardless of what you asked for; that interim is gone.
 *
 * ⚠️ **This principal cannot act ABOVE its star.** If a test needs to write the Galaxy's ontology,
 * read a Universe config, or otherwise reach an ancestor, it needs {@link universeAdminClient} —
 * and under the old body it got that by accident. A test that breaks on this change is telling you
 * it was relying on authority the scenario never described.
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
  const segments = scope.split('.');
  if (segments.length !== 3) {
    throw new Error(
      `adminClientAt is star-tier only — got "${scope}". Use universeAdminClient for a galaxy or ` +
      'universe scope (it guarantees the `{u}.*` wildcard your assertion depends on).',
    );
  }
  // ⚠️ Segment count is NOT sufficient. The reserved `.dev` star is 3 segments and still has no
  // founder of its own: `create-star` makes it (founderless by design), the covering admin's
  // wildcard administers it, and `claim-star` refuses the slug outright. So it needs
  // `universeAdminClient` for the same reason a galaxy does — which is how it works in production,
  // not a test concession.
  if (RESERVED_STAR_SLUGS.has(segments[2])) {
    throw new Error(
      `adminClientAt cannot serve the reserved star "${scope}" — a "${segments[2]}" star is ` +
      'founderless by construction (create-star, no founder; claim-star refuses the slug). ' +
      'Use universeAdminClient: the covering admin is how it is administered in production too.',
    );
  }
  const { accessToken, payload, authScope } = await foundStarAndLogin(browser, scope, email, activeScope);
  const client = await connectClient(ClientClass, browser, authScope, activeScope, appVersion, extraConfig);
  return { client, payload, accessToken };
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
 * Mint a **narrower** token for another person through the production `/mint-narrower-token` endpoint
 * (`sub` = `subOfNarrowerToken`, `act.sub` = the caller).
 *
 * The minted pattern is derived from the REQUESTED `activeScope` (`buildAuthScopePattern`), not the
 * caller's — but `activeScope` is bounded on BOTH sides: it must lie within the caller's own reach
 * AND within `buildAuthScopePattern(the subject's scope)`. The caller must additionally hold
 * `hasAdminOverScope` over the subject's scope (eligibility), and the subject must be a different
 * `sub`. So this is **not** "any scope at or below the caller's reach" — see
 * `tasks/nebula-mint-narrower-token.md` § *Design intent*.
 *
 * ADR-009 rung 1–2: real issuance through the real endpoint, no test-mode client mint.
 */
export async function mintNarrowerToken(
  browser: Browser,
  callerAuthScope: string,
  callerAccessToken: string,
  subOfNarrowerToken: string,
  activeScope: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  const resp = await browser.fetch(authUrl(`${callerAuthScope}/mint-narrower-token`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${callerAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subOfNarrowerToken, activeScope }),
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
