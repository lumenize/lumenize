/**
 * Shared test helpers for Nebula test files.
 *
 * Composes nebula-auth test mode login with NebulaClient creation.
 */
import { expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { RESERVED_STAR_SLUGS } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { hostOrigin } from '@lumenize/nebula-auth/claims';
import { NebulaClient } from '@lumenize/nebula';
import type { NebulaClientConfig } from '@lumenize/nebula';
import {
  requestUniverseClaim, requestStarClaim, requestMagicLink, createGalaxyViaFacade, consumeLink,
} from './lib/email-login';

/** The deployment this lane's Worker serves — `LUMENIZE_ORIGIN` in its `wrangler.jsonc`. */
export const DEPLOYMENT = 'http://lumenize.localhost';
/**
 * The platform host: every session's routes and the pages that sign a person in. Under
 * pool-workers `Browser` reaches the Worker through `SELF.fetch` whatever the host, so the lane uses
 * the deployment's real hosts.
 */
export const ORIGIN = hostOrigin({ kind: 'platform' }, DEPLOYMENT);

/**
 * Who founds the universe above an exact-star admin `email` — {@link foundStarAndLogin}'s owner.
 * A test needing that universe's admin after `adminClientAt(…, email)` logs in as this person: the
 * star admin cannot also be the universe's, since the refresh would then mint from the universe.
 */
export function ownerOf(email: string): string {
  return `owner-${email}`;
}

/** The host of `scope`'s own pages — where a client working in that scope lives. */
export function pageOf(scope: string): string {
  return hostOrigin({ kind: 'scope', scope }, DEPLOYMENT);
}

function authUrl(path: string): string {
  return `${ORIGIN}/auth/${path}`;
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
  return `s-${crypto.randomUUID().slice(0, 8)}.app.tenant`;
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
  const universe = `g-${crypto.randomUUID().slice(0, 8)}`;
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
 * which an *admin* identity can be minted.
 */
export function universeOf(scope: string): string {
  return scope.split('.')[0];
}

/**
 * Claim a universe and its first app — the **only open admin-minting path**
 * (`#mintIdentity(..., scopeAdmin: true)`). Returns the test-mode magic-link URL.
 *
 * ⚠️ Login NEVER mints. `requestMagicLink` creates a link for any email, but consuming it fails
 * unless a membership already exists (`resolveConsume` → no memberships → no session). So an
 * identity must be established here (claim) or via `createSubject` (invite) *before* any login.
 */
export async function claimUniverse(
  browser: Browser,
  universe: string,
  email: string,
  appSlug = 'first',
): Promise<string | null> {
  // Delegates to the vitest-free core in ./lib/email-login so the Node harness and these
  // vitest helpers can't drift apart on endpoint shape or 409 semantics. The 409 rule lives
  // there: slug already claimed → null, so the caller falls through to an ordinary login.
  const magicLinkUrl = await requestUniverseClaim({
    baseUrl: ORIGIN, universe, appSlug, email, fetchImpl: browser.fetch,
  });
  if (magicLinkUrl === null) return null;
  expect(magicLinkUrl).toBeDefined();
  return magicLinkUrl!;
}

/**
 * Claim a tenant Star (open self-signup) and return its test-mode claim link.
 *
 * `null` on 409 — already claimed, so the caller falls through to an ordinary login, which works
 * because the claim minted an identity to log in as.
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
 * Found a Star **as its own star-scoped admin** and capture the refresh cookie AT the star.
 *
 * The counterpart to {@link bootstrapAdmin}, and the difference is the whole point of the
 * star-scoped-admin change: this yields an **exact-star** `authScope`, inert at every ancestor
 * (ADR-015), where `bootstrapAdmin` yields a universe admin whose scope `{u}` merely *covers* the star.
 *
 * The universe and galaxy above must exist and only their own admin may create them, so they are
 * founded first — by a DIFFERENT person, {@link ownerOf}`(email)`, in a browser of their own. ⚠️ Never by
 * this email: a consume sets a cookie for every membership the address holds, and the refresh mints
 * from the broadest admin membership its cookies reach, so an address holding the universe would be
 * the universe's admin on the star's page too, never the exact-star admin this helper exists for.
 */
export async function foundStarAndLogin(
  browser: Browser,
  star: string,
  email: string,
  activeScope?: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload; authScope: string }> {
  const [universe, galaxySlug] = star.split('.');
  const galaxy = `${universe}.${galaxySlug}`;

  // 1–2. Universe + galaxy, by their own owner in their own browser. A new universe's claim writes
  // the galaxy as its first app. An existing one keeps whoever founded it: when that is this
  // helper's owner, the galaxy is created through the facade, the one way a session creates one
  // (an existing one is success); when a test founded it as someone else, the galaxy is theirs to
  // have made, and a missing one fails the star claim below as `parent_not_found`.
  const ownerBrowser = new Browser();
  const founded = await claimUniverse(ownerBrowser, universe, ownerOf(email), galaxySlug);
  if (founded) {
    await consumeLink(founded, ownerBrowser.fetch);
  } else {
    const link = await requestMagicLink({ baseUrl: ORIGIN, email: ownerOf(email), fetchImpl: ownerBrowser.fetch });
    await consumeLink(link!, ownerBrowser.fetch);
    const holds = await ownerBrowser.fetch(authUrl('accept-membership'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ scope: universe }),
    });
    if (holds.ok) {
      const { accessToken: ownerToken, payload: owner } = await refreshToken(ownerBrowser, universe);
      await createGalaxyViaFacade({
        baseUrl: pageOf(universe), accessToken: ownerToken, sub: owner.sub, universeGalaxyId: galaxy,
        WebSocket: ownerBrowser.WebSocket,
      });
    }
  }

  // 3. Claim the star as the tenant — open, no admin in the loop. A claim's page is its consent
  // screen, so its button accepts; the fallback login's does not, and Home's Accept takes it up.
  const claimLink = await claimStar(browser, star, email);
  const link = claimLink ?? (await requestMagicLink({
    baseUrl: ORIGIN, email, fetchImpl: browser.fetch,
  }));
  expect(link).toBeDefined();
  await consumeLink(link!, browser.fetch);
  await acceptMembershipVia(browser, star);

  const { accessToken, payload } = await refreshToken(browser, activeScope ?? star);
  return { accessToken, payload, authScope: star };
}

/**
 * Establish an admin for `scope`'s universe and capture its refresh cookie in `browser`. A new
 * universe's claim writes `scope`'s galaxy as its first app, or `first` when `scope` names none;
 * returns whether the claim was new, so a caller knows that galaxy exists.
 *
 * The cookie is named for the universe and lives on the platform host; a page anywhere beneath the
 * universe gets this admin's token from it.
 */
export async function bootstrapAdmin(
  browser: Browser,
  scope: string,
  email: string,
): Promise<boolean> {
  const universe = universeOf(scope);
  const claimLink = await claimUniverse(browser, universe, email, scope.split('.')[1] ?? 'first');
  if (claimLink) {
    // The claim's page is its consent screen: its Accept sets a cookie per membership and accepts
    // the claim's own.
    await consumeLink(claimLink, browser.fetch);
    return true;
  }
  // Already claimed (this admin backing a second client, or a second Browser for the same
  // identity) — request a fresh login link for the existing identity and press its Continue.
  const magicLinkUrl = await requestMagicLink({
    baseUrl: ORIGIN, email, fetchImpl: browser.fetch,
  });
  expect(magicLinkUrl).toBeDefined();
  await consumeLink(magicLinkUrl!, browser.fetch);
  // Idempotent: this identity may already have consented on an earlier Browser, and accepting
  // twice writes nothing new.
  await acceptMembershipVia(browser, universe);
  return false;
}

/**
 * Create a subject via admin invite + magic link flow.
 *
 * The invite rides the MESH — `NebulaClient.invite` → Gateway → `NEBULA_AUTH_FACADE` — the one
 * production surface (there is no HTTP invite route). The admin token this helper is handed backs
 * a short-lived client for exactly that call: a handed token on a client of the SAME identity is
 * the sanctioned shape (testing.md — renewal never runs inside this one-call lifetime), and it
 * keeps all ~40 call sites on the token-based signature they already have.
 * `options.scopeAdmin` rides the per-invitee entry (honored when the admin caller holds dominion).
 */
export async function createSubject(
  browser: Browser,
  authScope: string,
  adminAccessToken: string,
  email: string,
  options: { scopeAdmin?: boolean } = {},
): Promise<void> {
  const adminSub = (parseJwtUnsafe(adminAccessToken)!.payload as { sub: string }).sub;
  const adminClaims = parseJwtUnsafe(adminAccessToken)!.payload as unknown as NebulaJwtPayload;
  const adminBrowser = new Browser(); // own context — never the SUBJECT's cookie jar below
  const ctx = adminBrowser.context(pageOf(adminClaims.aud));
  const inviter = new NebulaClient({
    baseUrl: pageOf(adminClaims.aud),
    platformOrigin: ORIGIN,
    ontologyVersion: 'v1',
    accessToken: adminAccessToken,
    instanceName: `${adminSub}.${crypto.randomUUID().slice(0, 8)}`,
    fetch: ctx.fetch,
    WebSocket: ctx.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  try {
    await vi.waitFor(() => { expect(inviter.connectionState).toBe('connected'); });
    const summary = await inviter.invite(authScope, [
      { email, ...(options.scopeAdmin ? { scopeAdmin: true } : {}) },
    ]);
    expect(summary.errors).toHaveLength(0);
  } finally {
    inviter.disconnect();
  }

  // The subject signs in through a plain link and takes the membership up on Home, as a person who
  // closed the invite's consent screen would.
  const magicLinkUrl = await requestMagicLink({ baseUrl: ORIGIN, email, fetchImpl: browser.fetch });
  expect(magicLinkUrl).toBeDefined();
  await consumeLink(magicLinkUrl!, browser.fetch);
  await acceptMembershipVia(browser, authScope);
}

/**
 * Take up a membership on Home, using the browser's own cookie jar — the body names the scope, which
 * picks its cookie.
 *
 * ⚠️ **Not optional after a plain login.** A consume places a cookie for every membership of the
 * address, and each is INERT until its holder accepts — so a login that skipped this 401s at its
 * first refresh. An already-accepted membership answers 200 and changes nothing.
 */
export async function acceptMembershipVia(browser: Browser, scope: string): Promise<void> {
  const resp = await browser.fetch(authUrl('accept-membership'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ scope }),
  });
  expect(resp.status).toBe(200);
}

/**
 * The access token a page on `page`'s host gets: the refresh on the platform host, with `Origin`
 * naming the page and every cookie the browser holds. The membership it rests on is the server's
 * choice — the broadest admin one the cookies reach, else the page's own.
 */
export async function refreshToken(
  browser: Browser,
  page: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  const refreshResp = await browser.context(pageOf(page)).fetch(authUrl('refresh-token'), { method: 'POST' });
  expect(refreshResp.status).toBe(200);
  const { access_token, sub } = await refreshResp.json() as any;
  expect(access_token).toBeDefined();

  const { payload } = parseJwtUnsafe(access_token)!;
  return { accessToken: access_token, payload: payload as unknown as NebulaJwtPayload };
}

/**
 * Log in an **already-minted** identity at `authScope` (request link → Continue → accept → refresh).
 *
 * ⚠️ The identity must already exist at `authScope` — login never mints. Use this for an
 * **invited member** (`createSubject` minted them at that scope). For an admin use
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
    baseUrl: ORIGIN, email, fetchImpl: browser.fetch,
  });
  expect(magicLinkUrl).toBeDefined();

  // Continue — the browser captures a cookie per membership
  await consumeLink(magicLinkUrl!, browser.fetch);
  await acceptMembershipVia(browser, authScope); // inert until consent

  return refreshToken(browser, activeScope ?? authScope);
}

/**
 * Found a universe and log its admin in: claim (mints the universe admin, `scopeAdmin: true`) → click →
 * refresh. The admin counterpart to {@link browserLogin}.
 *
 * `scope` is the **hierarchy** you want to authenticate within — its universe is what gets
 * claimed and what the refresh cookie is scoped to. `activeScope` (defaulting to `scope`) is the
 * JWT `aud`; it may be any descendant, since the universe admin's pattern is `{universe}.*`.
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
  const claimed = await bootstrapAdmin(browser, scope, email);
  // A galaxy exists in the Registry before anything is written into it, as in production: its
  // creation wipes its Durable Objects, so registering it after a test had written there would
  // erase what the test wrote. A new claim wrote it as its first app; otherwise an existing one is
  // success.
  const [, galaxySlug] = scope.split('.');
  if (galaxySlug && !claimed) {
    const { accessToken: ownerToken, payload: owner } = await refreshToken(browser, universe);
    await createGalaxyViaFacade({
      baseUrl: pageOf(universe), accessToken: ownerToken, sub: owner.sub, universeGalaxyId: `${universe}.${galaxySlug}`,
      WebSocket: browser.WebSocket,
    });
  }
  const { accessToken, payload } = await refreshToken(browser, activeScope ?? scope);
  return { accessToken, payload, authScope: universe };
}

/**
 * Build + connect a client on `activeScope`'s page over the browser's established cookies. Shared
 * by every factory. The page names nothing: the client takes its scope from its first token.
 */
async function connectClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  activeScope: string,
  ontologyVersion: string,
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<T> {
  const ctx = browser.context(pageOf(activeScope));
  const client = new ClientClass({
    baseUrl: pageOf(activeScope),
    platformOrigin: ORIGIN,
    ontologyVersion,
    fetch: ctx.fetch,
    WebSocket: ctx.WebSocket,
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
 * ✅ **Mints a REAL star-scoped admin** (2026-07-25) — `claim-star` self-signup, `authScope` =
 * the exact star id, inert at every ancestor (ADR-015). It used to hand back a universe admin
 * (`{u}`) regardless of what you asked for; that interim is gone.
 *
 * ⚠️ **This principal cannot act ABOVE its star.** If a test needs to write the Galaxy's ontology,
 * read a Universe config, or otherwise reach an ancestor, it needs {@link universeAdminClient} —
 * and under the old body it got that by accident. A test that breaks on this change is telling you
 * it was relying on authority the scenario never described.
 *
 * ⚠️ If your assertion depends on the caller's scope COVERING others (cross-tier calls, `{u}` widening,
 * "an admin with no DAG grant on this node"), you want {@link universeAdminClient} — this one's
 * guarantee will change under you.
 */
export async function adminClientAt<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  scope: string,
  activeScope: string,
  email: string,
  ontologyVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  const segments = scope.split('.');
  if (segments.length !== 3) {
    throw new Error(
      `adminClientAt is star-tier only — got "${scope}". Use universeAdminClient for a galaxy or ` +
      'universe scope (it guarantees the covering `{u}` scope your assertion depends on).',
    );
  }
  // ⚠️ Segment count is NOT sufficient. The reserved `.dev` star is 3 segments, and nobody founds
  // it: it is born with its galaxy, minting no identity, and `claim-star` refuses the slug, so this
  // helper, which founds the Star it logs into, cannot serve it. Its admins are the covering admin
  // and an app invitee's co-minted `.dev` membership; `universeAdminClient` gives the first, as it
  // does for a galaxy.
  if (RESERVED_STAR_SLUGS.has(segments[2])) {
    throw new Error(
      `adminClientAt cannot serve the reserved star "${scope}" — nobody founds a "${segments[2]}" star ` +
      '(it is born with its galaxy; claim-star refuses the slug). ' +
      'Use universeAdminClient: the covering admin administers it in production too.',
    );
  }
  const { accessToken, payload } = await foundStarAndLogin(browser, scope, email, activeScope);
  const client = await connectClient(ClientClass, browser, activeScope, ontologyVersion, extraConfig);
  return { client, payload, accessToken };
}

/**
 * **Specifically a universe-tier admin** (`authScope` = `{u}`), on the page `activeScope`.
 *
 * Use this — and *only* this — when the assertion depends on a covering membership: one admin
 * acting across several scopes, or "an admin with no DAG grant on this node". Unlike
 * {@link adminClientAt}, this guarantee is **stable** across the star-scoped-admin change.
 *
 * ⚠️ **Dominion reads the page, not the membership** (the host rule, ADR-015 and ADR-022). The
 * client holds dominion over `activeScope` and everything beneath it, and only passage above it:
 * a universe admin on a tenant's page cannot administer the galaxy. So put `activeScope` at the
 * highest scope the test acts on with dominion, as production puts a person on that scope's page.
 *
 * `scope` may be any tier — the universe is derived from it.
 */
export async function universeAdminClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  /**
   * The scope you want to WORK IN (typically a star). ⚠️ **Not where the login happens** — the
   * universe above it is founded and logged into, so the returned client's `authScope` is the
   * UNIVERSE. Read `authScope` off the result rather than assuming this value.
   */
  scope: string,
  activeScope: string,
  email: string,
  ontologyVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string; authScope: string }> {
  return createAuthenticatedClient(ClientClass, browser, scope, activeScope, email, ontologyVersion, extraConfig);
}

/**
 * Create an authenticated **admin** NebulaClient and wait for it to connect.
 *
 * ⚠️ **Prefer {@link adminClientAt} or {@link universeAdminClient}** — they encode INTENT (what the
 * test needs) rather than PROVENANCE (how the identity was minted), so the star-scoped-admin change
 * touches one helper body instead of every call site. This remains the shared implementation both
 * delegate to, and the right choice only where the admin-mint mechanics are themselves the
 * subject.
 *
 * Each test-app passes its own client class (e.g., NebulaClientTest).
 *
 * `scope` is the **hierarchy** to authenticate within: its universe is claimed (minting a universe admin
 * with `scopeAdmin: true` at `{universe}`), and that membership becomes the client's `authScope` on
 * every page beneath it. `activeScope` is the page, and so the JWT `aud` — any descendant of that
 * universe. ⚠️ **The client's `authScope` is therefore the universe, not `scope`.**
 *
 * For an **invited member** (no admin, minted at a non-universe scope by `createSubject`) use
 * {@link createInvitedClient} instead — this factory would mint them a *second*, admin identity.
 *
 * `ontologyVersion` defaults to `'v1'` (matches `ONTOLOGY_VERSION` in
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
  ontologyVersion: string = 'v1',
  /** Optional extra config to pass through to the client constructor —
   *  e.g. `{ onShouldRefreshUI: fn }` for the staleness tests. */
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string; authScope: string }> {
  const { accessToken, payload, authScope } = await foundAndLogin(browser, scope, email, activeScope);
  const client = await connectClient(ClientClass, browser, activeScope, ontologyVersion, extraConfig);
  // ⚠️ `authScope` is RETURNED because it is NOT the `scope` you passed — `foundAndLogin` founds the
  // UNIVERSE above it, and that membership is what the token rests on. Pass `star` and you get a
  // `{u}` admin.
  return { client, payload, accessToken, authScope };
}

/** The reserved platform scope, and the bootstrap email bound in `vitest.config.js` miniflare.bindings. */
export const PLATFORM_SCOPE = '_platform';
export const BOOTSTRAP_EMAIL = 'bootstrap-admin@example.com';

/**
 * Log in the configured **platform bootstrap admin** (`authScope: '_platform'`) at `activeScope`.
 *
 * This is the ONE production path to a *second* `access.scopeAdmin` identity in a universe that already
 * has an admin: `requestMagicLink` mints the bootstrap email at `_platform`
 * (`nebula-auth-registry.ts` — the only email-magic-link mint), and `*` covers every scope. It holds
 * **no DAG grant** in any Star's tree, as no admin does — which is exactly the shape the stored-bypass
 * fixtures need ("`access.scopeAdmin` with no DAG grant of its own").
 *
 * ⚠️ Only usable where `NEBULA_AUTH_BOOTSTRAP_EMAIL` is bound (baseline project). Without it, login
 * succeeds but the first authed route 403s.
 */
export async function createPlatformAdminClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  activeScope: string,
  ontologyVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  const { accessToken, payload } = await browserLogin(browser, PLATFORM_SCOPE, BOOTSTRAP_EMAIL, activeScope);
  const client = await connectClient(ClientClass, browser, activeScope, ontologyVersion, extraConfig);
  return { client, payload, accessToken };
}

/**
 * Create an authenticated client for an **already-minted, non-admin** identity — the invitee
 * half of the pair with {@link createAuthenticatedClient}. `authScope` is where the invite minted
 * them (`createSubject`'s scope), whose membership they accept on Home.
 */
export async function createInvitedClient<T extends NebulaClient>(
  ClientClass: new (config: NebulaClientConfig) => T,
  browser: Browser,
  authScope: string,
  activeScope: string,
  email: string,
  ontologyVersion: string = 'v1',
  extraConfig?: Partial<NebulaClientConfig>,
): Promise<{ client: T; payload: NebulaJwtPayload; accessToken: string }> {
  const { accessToken, payload } = await browserLogin(browser, authScope, email, activeScope);
  const client = await connectClient(ClientClass, browser, activeScope, ontologyVersion, extraConfig);
  return { client, payload, accessToken };
}
