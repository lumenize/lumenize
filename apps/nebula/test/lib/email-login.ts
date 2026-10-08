/**
 * Real email login for Nebula — rung 1 of the ADR-009 ladder, at the API level.
 *
 * This is the helper that makes "drive a real `NebulaClient` through the real
 * login" (`testing.md` § Philosophy) the *easy* thing rather than the
 * aspirational one. Before it existed, real login was reachable only through a
 * browser harness (Playwright) or `prodLogin` (deployed prod only), so anything
 * API-level and local reached for `createNebulaTestToken` — the last resort —
 * by default.
 *
 * Deliberately free of `node:` imports and of `cloudflare:*` imports, so the
 * SAME code path runs in Node (the `/live` harness, ui-smoke) and inside
 * workerd (vitest-plugin test-apps). Anything that needs the filesystem —
 * e.g. the harness's stored-session cache — layers on top rather than living
 * here.
 *
 * The loop costs ~1.4 s standalone and ~0.9 s marginal inside a running suite
 * (measured 2026-07-21, `tasks/email-latency-cf-vs-resend.md`). That is cheap
 * enough that speed is never a reason to drop to a lower rung.
 */
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { LumenizeClient } from '@lumenize/mesh/client';
import { hostOrigin } from '@lumenize/nebula-auth/claims';
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';

/** Cookie-aware fetch. `@lumenize/testing`'s `Browser` satisfies this, as does global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The instance tag a SCOPE-LESS magic link's mail carries — mirrors `SCOPELESS_INSTANCE_TAG`. */
const SCOPELESS_TAG = '_scopeless';

export interface EmailLoginOptions {
  /**
   * The platform host's origin, where every session route answers —
   * `http://platform.lumenize.localhost:<port>` for a local stack, the same host for an in-process
   * vitest-plugin Worker, `https://platform.lumenize-test.dev` deployed. Trailing slash ok.
   */
  baseUrl: string;
  /** The membership whose cookie this login is for — its scope names the cookie. */
  authScope: string;
  /** TEST_TOKEN for the deployed email-test Worker. */
  testToken: string;
  /**
   * Identity to log in. Defaults to a fresh `test-<uuid>@lumenize-test.dev`, which is
   * both routed by the catch-all AND unique — so concurrent logins can't steal
   * each other's magic link.
   */
  email?: string;
  /**
   * Cookie-aware fetch to drive the flow with. Pass a `Browser` instance's
   * `fetch` when you want the refresh cookie captured in its jar (the usual
   * case for tests); omit to use global `fetch` and work from the returned
   * `refreshToken` (the usual case for a harness that persists a session).
   */
  fetchImpl?: FetchLike;
  /**
   * Where the magic link comes from — the ADR-009 rung, made explicit:
   *
   * - `'email'` (default, **rung 1**) — the real thing: the server sends, the deployed
   *   email-test Worker receives, the link arrives over a WebSocket push.
   * - `'test-mode'` (**rung 2**) — the server returns `magicLinkUrl` in the response body
   *   instead of sending. Requires `AUTH_TEST_MODE=true` on the worker.
   *
   * ⚠️ Rung 2 is **still real server issuance** — real `MagicLinks` row, real consume, real
   * cookie, real JWT. The ONLY thing it skips is the email hop. It is emphatically not a
   * client-side mint (rung 3), and it is a legitimate choice for an isolated unit lane that
   * shouldn't take a network dependency. Prefer `'email'` wherever the lane can afford it.
   */
  channel?: 'email' | 'test-mode';
  /** Turnstile bypass token. Omit where Turnstile is off — it is, in local dev. */
  bypassToken?: string;
  /** Email-wait ceiling. Default 60 s (the loop is ~1.4 s; this is slack, not an expectation). */
  timeout?: number;
}

export interface EmailSession {
  /** The refresh cookie's value — a real credential. NEVER log it. */
  refreshToken: string;
  /** The membership's scope, which names its cookie: `__Host-refresh-token.{authScope}`. */
  authScope: string;
  email: string;
  savedAt: string;
}

const BYPASS_HEADER = 'x-lumenize-turnstile-bypass';

/** A lock older than this is taken as abandoned: a round trip is a few seconds, its email wait 60 s. */
const MAILBOX_LOCK_STALE_MS = 180_000;
/** How long a sign-in waits for others to the same address before giving up. */
const MAILBOX_LOCK_WAIT_MS = 300_000;

/**
 * Run one email round trip (arm the waiter, ask for the mail, consume its link) with no other round
 * trip to the same address in flight on this machine. Two waiters on one address both resolve with
 * the first mail, so two concurrent sign-ins as a shared address, such as a deployed sweep's shared
 * app owner at `--concurrency=2`, click one link twice and the second gets `link_used` (2026-10-07).
 * A lock directory per address under the OS temp dir serializes them across the sweep's processes.
 * Inside workerd, which loads this file too, the round trip runs unlocked.
 */
async function withMailbox<T>(email: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') return fn();
  const { mkdirSync, rmSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const dir = join(tmpdir(), 'lumenize-mailbox-locks');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24));
  for (const started = Date.now(); ;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; } // released meanwhile
      if (age > MAILBOX_LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - started > MAILBOX_LOCK_WAIT_MS) {
        throw new Error(`waited ${MAILBOX_LOCK_WAIT_MS / 1000}s for another sign-in as ${email} to finish`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Every refresh cookie's name: the prefix, then the membership's scope. */
const REFRESH_COOKIE_PREFIX = '__Host-refresh-token.';

/** One membership's refresh cookie as a browser presents it. */
export function refreshCookie(scope: string, token: string): string {
  return `${REFRESH_COOKIE_PREFIX}${scope}=${token}`;
}

/** A scope's own host, at the platform host's port — where a page on that scope lives. */
export function scopeOriginFrom(platformUrl: string, scope: string): string {
  const url = new URL(platformUrl);
  if (!url.hostname.startsWith('platform.')) {
    throw new Error(`expected the platform host's origin, got ${url.origin}`);
  }
  const deployment = `${url.protocol}//${url.hostname.slice('platform.'.length)}`;
  return hostOrigin({ kind: 'scope', scope }, deployment, url.origin);
}

/**
 * The refresh cookie a consume set FOR A GIVEN SCOPE.
 *
 * ⚠️ **A consume sets one cookie per membership of the address (mint-all), so "the first cookie" is
 * not something a caller can rely on.** Each is named for its membership's scope, so the scope is
 * read back from the name.
 */
export function refreshTokenForScope(headers: string[], scope: string): string | undefined {
  const name = `${REFRESH_COOKIE_PREFIX}${scope}=`;
  for (const c of headers) {
    if (c.startsWith(name)) return c.slice(name.length).split(';')[0];
  }
  return undefined;
}

/**
 * Press a link's page's button — the page's same-origin `POST /auth/magic-link`, on the host the
 * link names, as sent. The page's own `GET` changes nothing, so this is the one request that
 * consumes. For a link that opens a pending membership — a claim's or an invite's — it is the
 * consent screen's Accept, and `body` carries the names the screen collects.
 */
export async function consumeLink(
  link: string, fetchImpl: FetchLike = fetch, body: Record<string, unknown> = {},
): Promise<Response> {
  const url = new URL(link);
  const token = url.searchParams.get('token');
  if (!token) throw new Error(`no token in the link's ${url.pathname}`);
  return fetchImpl(`${url.origin}/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ token, ...body }),
  });
}

/**
 * Take up a membership on Home — `accept-membership`, naming the scope whose cookie it presents.
 *
 * A plain login link places a pending membership's cookie without accepting it, which is what this
 * is for; a claim's or an invite's own link accepts as it is consumed. An already-accepted
 * membership answers 200 and changes nothing.
 */
export async function acceptMembership(
  baseUrl: string, refreshToken: string, scope: string, fetchImpl: FetchLike = fetch,
): Promise<void> {
  const origin = baseUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${origin}/auth/accept-membership`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: refreshCookie(scope, refreshToken) },
    body: JSON.stringify({ scope }),
  });
  if (!res.ok) throw new Error(`accept-membership ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * `POST /auth/refresh-token` as a page on `scope`'s host sends it — `Origin` names the page, the
 * cookies ride, no body — and the raw answer, for a caller that asserts a refusal.
 */
export function refreshFromPage(
  baseUrl: string, scope: string, cookieHeader: string, fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const origin = baseUrl.replace(/\/$/, '');
  return fetchImpl(`${origin}/auth/refresh-token`, {
    method: 'POST', headers: { Origin: scopeOriginFrom(origin, scope), Cookie: cookieHeader },
  });
}

/** `POST /auth/home-summary` as Home on the platform host sends it, and the raw answer. */
export function homeSummary(baseUrl: string, cookieHeader: string, fetchImpl: FetchLike = fetch): Promise<Response> {
  return fetchImpl(`${baseUrl.replace(/\/$/, '')}/auth/home-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: cookieHeader },
    body: '{}',
  });
}

/**
 * Accept an invite on its link's page and come back with the session it set — the invitee's whole
 * arrival, in one call. The page's Accept consumes the link and accepts the membership together, so
 * the cookie it sets mints at once.
 *
 * The consume's response is returned because scenarios legitimately assert on it — its `redirect`
 * is the landing contract. A scenario testing consent ITSELF must NOT use this.
 */
export async function acceptInviteAndLogin(options: {
  baseUrl: string;
  /** The `/auth/magic-link?token=…` URL from the invitation, followed as sent. */
  inviteLink: string;
  /** The scope being joined — picks the cookie by name and names what is consented to. */
  scope: string;
  fetchImpl?: FetchLike;
  /** The names the consent screen collects. */
  names?: { nickname?: string; name?: string };
}): Promise<{ refreshToken: string; clicked: Response }> {
  const { inviteLink, scope, fetchImpl = fetch } = options;
  const clicked = await consumeLink(inviteLink, fetchImpl, options.names ?? {});
  const refreshToken = refreshTokenForScope(setCookieHeaders(clicked), scope);
  if (!refreshToken) {
    throw new Error(
      `the invite's Accept (${clicked.status}) set no refresh cookie for "${scope}": ` +
      `${(await clicked.clone().text().catch(() => '')).slice(0, 200)}`,
    );
  }
  return { refreshToken, clicked };
}

/** Read Set-Cookie across runtimes — `getSetCookie()` in Node/workerd, single header elsewhere. */
export function setCookieHeaders(res: Response): string[] {
  const multi = res.headers.getSetCookie?.();
  if (multi && multi.length > 0) return multi;
  const single = res.headers.get('Set-Cookie');
  return single ? [single] : [];
}

// ─── Shared primitives ────────────────────────────────────────────────────────
// The vitest-free core. `test/test-helpers.ts` builds its `expect`-flavoured surface
// on top of these instead of re-implementing the HTTP shapes — same endpoints, same
// 409 semantics, one place. (No host rewriting anywhere: every emailed link is followed AS SENT.)
// Keep them free of `vitest` and `cloudflare:*` so the Node harness can use them.
//
// Why two surfaces still exist (the accurate reasons — commit 3c6641f's message got
// one of them wrong and it should not be inherited):
//   1. `test-helpers.ts` imports `expect` from vitest. The Node harness cannot, so it
//      cannot consume that module at all. This is the real separator.
//   2. `refreshAccessToken` takes an EXPLICIT refresh token because `harness/lib/
//      prod-drive.ts` persists a session to `.prod-session.json` and refreshes on a
//      LATER PROCESS invocation. A cookie jar is per-`Browser`-instance and in-memory,
//      so it cannot span processes. Nothing to do with Node.
// ⚠️ NOT a reason: "the Node harness can't use the cookie jar." It can and does —
// `@lumenize/testing`'s `Browser` is Node-safe (no workerd-only imports) and the
// harness constructs it directly. Pass `fetchImpl: browser.fetch` and the jar captures
// the refresh cookie exactly as it does under vitest; that is the normal path here.


/**
 * Every universe a claim through {@link requestUniverseClaim} wrote in this process, with the address
 * that claimed it. The `/live` harness deletes the accepted ones when a scenario ends, which hands
 * back the certificate pack each claim's first app ordered (`harness/lib/shared-app.ts`); nothing
 * else reads it.
 */
export const claimedUniverses: Array<{ universe: string; email: string }> = [];

/**
 * POST `claim-universe` — the one open, admin-minting entry point, which writes the account and its
 * first app, `{universe}.{appSlug}` with its `.dev` Star. Returns the magic-link URL in test mode,
 * `undefined` in email mode (the link arrives by email instead), or `null` when the slug is
 * **already claimed** (409).
 *
 * ⚠️ 409 is legitimate and common, not an error: one admin backing several clients claims
 * once, then re-logs-in. Callers fall through to an ordinary login. It is NOT silently
 * swallowed — if the universe was claimed by a *different* email, no identity exists for
 * this one and the login fails visibly at consume.
 */
export async function requestUniverseClaim(options: {
  baseUrl: string; universe: string; appSlug: string; email: string;
  fetchImpl?: FetchLike; bypassToken?: string;
}): Promise<string | null | undefined> {
  const { baseUrl, universe, appSlug, email, fetchImpl = fetch, bypassToken } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bypassToken) headers[BYPASS_HEADER] = bypassToken;
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/auth/claim-universe`, {
    method: 'POST', headers, body: JSON.stringify({ slug: universe, appSlug, email }),
  });
  if (res.status === 409) return null;
  if (!res.ok) {
    throw new Error(`claim-universe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  claimedUniverses.push({ universe, email });
  return ((await res.json()) as { magicLinkUrl?: string }).magicLinkUrl;
}

/**
 * POST `email-magic-link` — the SCOPE-LESS login request.
 *
 * Returns the link URL in test mode, `undefined` in email mode.
 *
 * ⚠️ **It takes no scope, because there is no longer one to take.** The
 * `/auth/{scope}/email-magic-link` sibling is retired: naming a scope up front forced a caller to
 * KNOW their scope before proving anything, which is the enumeration the prove-then-choose design
 * deletes. The consume hands back EVERY membership the address holds, so a caller wanting one in
 * particular picks its cookie out of the set (`refreshTokenForScope`).
 *
 * ⚠️ **A waiter on this mail must be tagged `_scopeless`**, not with a universe — a request that
 * names no scope cannot tag its mail with one, and a mis-tagged waiter hangs for its full timeout
 * and reads as a slow boot.
 */
export async function requestMagicLink(options: {
  baseUrl: string; email: string;
  fetchImpl?: FetchLike; bypassToken?: string;
  /** A page on this deployment to come back to — checked by the server, which stores it with the link. */
  returnTo?: string;
}): Promise<string | undefined> {
  const { baseUrl, email, fetchImpl = fetch, bypassToken, returnTo } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bypassToken) headers[BYPASS_HEADER] = bypassToken;
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/auth/email-magic-link`, {
    method: 'POST', headers, body: JSON.stringify({ email, ...(returnTo ? { return_to: returnTo } : {}) }),
  });
  if (!res.ok) {
    // 403 here usually means Turnstile blocked us — a missing/stale bypassToken.
    throw new Error(`email-magic-link ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { magicLinkUrl?: string }).magicLinkUrl;
}

/**
 * POST `claim-star` — the open Star self-signup, and the one way a tenant Star comes to exist. Mints
 * a `scopeAdmin` star-scoped admin AT the star scope and issues its claim link in one call. Returns
 * the link in test mode, `undefined` in email mode, or `null` on 409 (already claimed — fall through
 * to an ordinary login for the existing identity).
 *
 * ⚠️ Requires the parent galaxy to exist, and refuses reserved environment slugs (`dev`). Nobody
 * founds a `{u}.{g}.dev` workspace — it is born with its galaxy — so drive it from a covering admin.
 */
export async function requestStarClaim(options: {
  baseUrl: string; universeGalaxyStarId: string; email: string;
  fetchImpl?: FetchLike; bypassToken?: string;
}): Promise<string | null | undefined> {
  const { baseUrl, universeGalaxyStarId, email, fetchImpl = fetch, bypassToken } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bypassToken) headers[BYPASS_HEADER] = bypassToken;
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/auth/claim-star`, {
    method: 'POST', headers, body: JSON.stringify({ universeGalaxyStarId, email }),
  });
  if (res.status === 409) return null;
  if (!res.ok) {
    throw new Error(`claim-star ${res.status} for ${universeGalaxyStarId}: ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { magicLinkUrl?: string }).magicLinkUrl;
}

/**
 * Provision a tenant Star and log in AS ITS FOUNDER — a real, star-scoped session whose refresh
 * cookie is `__Host-refresh-token.{u}.{g}.{s}` and whose token carries an **exact-star** `authScope`.
 *
 * This is what {@link provisionAndLogin} cannot give you. That helper climbs: it claims the
 * *universe* and returns a universe-admin token whose scope `{u}` merely *covers* the star. The
 * difference is not cosmetic — a universe admin is admin everywhere above the star too, so any test
 * asserting confinement passes vacuously under it (ADR-015). Use this wherever the fixture means "an
 * admin **at** this star".
 *
 * The universe and galaxy above still have to exist, and only their own admin may create them, so
 * steps 1–2 remain the climb. Step 3 is the new capability: `claim-star` mints the star-scoped admin and emails
 * the link in one open call.
 *
 * ⚠️ `star` must NOT be a reserved environment slug (`dev`) — see {@link requestStarClaim}.
 */
export async function provisionStarAdmin(
  options: Omit<EmailLoginOptions, 'authScope'> & {
    scope: string;
    /** Who owns the account above, when it exists already, such as a `/live` run's shared app;
     *  otherwise a stranger, `owner-{email}`, claims it. */
    ownerEmail?: string;
  },
): Promise<{ accessToken: string; sub: string; session: EmailSession }> {
  const { scope, baseUrl, testToken, fetchImpl = fetch, bypassToken, timeout, ownerEmail, ...rest } = options;
  const email = options.email ?? uniqueTestEmail();
  const origin = baseUrl.replace(/\/$/, '');
  const parts = scope.split('.');
  if (parts.length !== 3) {
    throw new Error(`provisionStarAdmin needs a 3-segment star scope, got "${scope}"`);
  }
  const [universe, galaxy] = parts;
  const useEmail = (options.channel ?? 'email') === 'email';

  // 1–2. The universe + galaxy above the star, provisioned by the universe admin (a DIFFERENT
  //      identity from the star-scoped admin — which is the point: the star-scoped admin is a stranger).
  //      ⚠️ On a fetch of its own, never the caller's: a different person is a different browser, and
  //      a browser holding the owner's cookie gets the owner's token on every page beneath, since
  //      the refresh picks the broadest admin membership the cookies reach.
  await provisionAndLogin({
    ...rest, baseUrl, testToken, bypassToken, timeout, fetchImpl: fetch,
    scope: `${universe}.${galaxy}`, email: ownerEmail ?? `owner-${email}`,
  });

  // 3. Claim the star as the tenant. Open — no admin in the loop, no token needed.
  // ⚠️ **No `instance` filter, because the branch below decides the tag and it has not run yet.**
  // A claim issues its own link tagged with the star; the 409 fallback sends a SCOPE-LESS one
  // tagged `_scopeless`. Arming on either tag makes the other branch wait out the full timeout —
  // which is what it did, silently, for every already-claimed star. The unique recipient is the
  // discriminator here; `instance` was only ever a concurrency filter, and it cannot be applied
  // before the thing it filters on is known.
  const session = await withMailbox(email, async (): Promise<EmailSession> => {
  const waiter = useEmail
    ? waitForEmail({ testToken, to: email, timeout: timeout ?? 60_000 })
    : undefined;
  try {
    const claimed = await requestStarClaim({
      baseUrl: origin, universeGalaxyStarId: scope, email, fetchImpl, bypassToken,
    });
    // 409 — already claimed (a second Browser for the same admin). An ordinary login works,
    // because a claimed Star HAS an identity.
    const rawLink = claimed === null
      ? await requestMagicLink({ baseUrl: origin, email, fetchImpl, bypassToken })
      : claimed;

    let link: string;
    if (useEmail) {
      link = extractMagicLink(await waiter!.emailPromise);
    } else {
      if (!rawLink) {
        throw new Error(
          "channel 'test-mode' but no magicLinkUrl came back — " +
          'AUTH_TEST_MODE must be "true" on the worker for this channel',
        );
      }
      link = rawLink;
    }
    // The claim's page is its consent screen, so its Accept consumes and accepts; the plain-login
    // fallback places the cookie and Home's Accept takes it up (an already-accepted one is a no-op).
    const linkRes = await consumeLink(link, fetchImpl);
    const refreshToken = refreshTokenForScope(setCookieHeaders(linkRes), scope);
    if (!refreshToken) {
      throw new Error(
        `claim-star link's consume (${linkRes.status}) set no refresh cookie for "${scope}": ` +
        `${(await linkRes.clone().text().catch(() => '')).slice(0, 200)}`,
      );
    }
    await acceptMembership(origin, refreshToken, scope, fetchImpl);
    return { refreshToken, authScope: scope, email, savedAt: new Date().toISOString() };
  } finally {
    waiter?.cleanup();
  }
  });

  const { accessToken, sub } = await refreshAccessToken(origin, session, scope, fetchImpl);
  return { accessToken, sub, session };
}

/**
 * Log in for real: POST the magic-link request → catch the email via the email-test Worker →
 * press the link page's Continue → capture the membership's refresh cookie → accept it on Home.
 *
 * No test-mode bypass and no synthetic mint — this walks the same path a user
 * walks, which is the whole point: a shortcut path exercises different code, and
 * the divergence is where the bugs were hiding.
 */
export async function loginViaEmail(options: EmailLoginOptions): Promise<EmailSession> {
  const {
    baseUrl, authScope, testToken,
    email = uniqueTestEmail(),
    fetchImpl = fetch,
    bypassToken,
    timeout = 60_000,
  } = options;
  const origin = baseUrl.replace(/\/$/, '');

  // Attach the listener BEFORE sending — the EmailTestDO pushes only to
  // already-connected sockets and never replays stored mail.
  // ⚠️ `_scopeless`: the request names no scope, so its mail cannot be tagged with one. A waiter
  // filtered on `authScope` here hangs for its full timeout and reads as a slow boot.
  return withMailbox(email, async () => {
  const waiter = waitForEmail({ testToken, instance: SCOPELESS_TAG, to: email, timeout });
  try {
    await requestMagicLink({ baseUrl: origin, email, fetchImpl, bypassToken });

    const link = extractMagicLink(await waiter.emailPromise);
    const linkRes = await consumeLink(link, fetchImpl);
    const refreshToken = refreshTokenForScope(setCookieHeaders(linkRes), authScope);
    if (!refreshToken) {
      // Say WHY, not just "no cookie": the body carries the auth layer's own error code when the
      // link was refused, and the other cookie names separate "server never set it" from "our
      // client dropped it". Report both; don't guess between them.
      const others = setCookieHeaders(linkRes).map((c) => c.split('=')[0]).join(', ') || '(none)';
      throw new Error(
        `the link's consume (${linkRes.status}) set no refresh cookie for "${authScope}" — ` +
        `body=${(await linkRes.clone().text().catch(() => '')).slice(0, 200)}; Set-Cookie names=${others}`,
      );
    }

    // A plain link accepts nothing, so a pending membership is taken up on Home, as its holder
    // would; an accepted one answers 200 and changes nothing.
    await acceptMembership(origin, refreshToken, authScope, fetchImpl);

    return { refreshToken, authScope, email, savedAt: new Date().toISOString() };
  } finally {
    waiter.cleanup();
  }
  });
}

/**
 * Exchange a refresh token for an access token whose `aud` is `activeScope` — the refresh a page on
 * `activeScope`'s host sends: `Origin` names that page, the membership's cookie rides, no body. Not
 * Turnstile-gated, so no bypass token is involved.
 */
export async function refreshAccessToken(
  baseUrl: string,
  session: Pick<EmailSession, 'refreshToken' | 'authScope'>,
  activeScope: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accessToken: string; sub: string }> {
  const origin = baseUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${origin}/auth/refresh-token`, {
    method: 'POST',
    headers: {
      Origin: scopeOriginFrom(origin, activeScope),
      Cookie: refreshCookie(session.authScope, session.refreshToken),
    },
  });
  if (!res.ok) throw new Error(`refresh-token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { access_token, sub } = (await res.json()) as { access_token: string; sub: string };
  return { accessToken: access_token, sub };
}

/**
 * Provision a scope and log in as its real admin — the rung-1 path for a scope
 * that does not exist yet.
 *
 * Why this and not just `loginViaEmail`: **login never mints an identity.** Identity
 * mint is authority-point-only (`nebula-auth-registry.ts` says outright *"NEVER call
 * from a login path"*), so an address holding no membership gets a link whose Continue sends it
 * to sign up, holding no refresh cookie. The one open, admin-minting entry point today is
 * `claim-universe`, which mints the universe admin with `scopeAdmin: true` before sending the link.
 *
 * So: claim the **universe** with the requested galaxy as its first app, log in there for real,
 * then create what is left beneath it with that admin's token. The returned token's universe-admin reach covers every
 * scope below, which is what lets a caller drive a star it never logged into directly —
 * the same shape prod uses (`prodLogin`'s root cookie, refreshed on the target's page).
 *
 * A galaxy the claim did not write — the universe was claimed already — is created the one way a
 * session creates one, `NebulaAuthFacade.createGalaxy`, on a short-lived mesh client
 * ({@link createGalaxyViaFacade}). A scope with no galaxy segment claims the first app `first`. A
 * tenant Star is founded the one way any comes to exist, by its own claimer, who then accepts it
 * ({@link foundTenantStar}); the universe admin's dominion is what drives it. To log in AS a star's
 * own admin, use {@link provisionStarAdmin}.
 *
 * @param scope 1–3 dot-separated segments (`u`, `u.g`, or `u.g.s`). Each level below the
 *              universe is created in order.
 */
export async function provisionAndLogin(
  options: Omit<EmailLoginOptions, 'authScope'> & { scope: string },
): Promise<{ accessToken: string; sub: string; session: EmailSession; link: string }> {
  const { scope, baseUrl, testToken, fetchImpl = fetch, bypassToken, timeout } = options;
  const email = options.email ?? uniqueTestEmail();
  const origin = baseUrl.replace(/\/$/, '');
  const [universe, galaxy, star] = scope.split('.');
  // 1. Claim the universe. Open + Turnstile-only, and the ONLY thing here that mints an
  //    identity — it also issues the magic link, so no separate email-magic-link call.
  const useEmail = (options.channel ?? 'email') === 'email';
  // ⚠️ **No `instance` filter — see `provisionStarAdmin`'s waiter.** The claim tags its link with
  // the universe; the already-claimed fallback below sends a `_scopeless` one. The recipient is
  // unique, so it is the filter that actually discriminates.
  // `usedLink` is returned to the caller, so a scenario can show the link is now spent: a link signs in once.
  const { session, usedLink, claimedFresh } = await withMailbox(email, async () => {
  const waiter = useEmail
    ? waitForEmail({ testToken, to: email, timeout: timeout ?? 60_000 })
    : undefined;
  try {
    const claimed = await requestUniverseClaim({
      baseUrl: origin, universe, appSlug: galaxy ?? 'first', email, fetchImpl, bypassToken,
    });
    const claimedFresh = claimed !== null;
    let rawLink: string | undefined;
    if (claimed === null) {
      // Already claimed — fall through to an ordinary login for the existing identity.
      rawLink = await requestMagicLink({ baseUrl: origin, email, fetchImpl, bypassToken });
    } else {
      rawLink = claimed;
    }
    let link: string;
    if (useEmail) {
      link = extractMagicLink(await waiter!.emailPromise);
    } else {
      if (!rawLink) {
        throw new Error(
          "channel 'test-mode' but no magicLinkUrl came back — " +
          'AUTH_TEST_MODE must be "true" on the worker for this channel',
        );
      }
      link = rawLink;
    }
    // The claim's page is its consent screen, so its Accept consumes and accepts; the plain-login
    // fallback places the cookie and Home's Accept takes it up (an already-accepted one is a no-op).
    const linkRes = await consumeLink(link, fetchImpl);
    const refreshToken = refreshTokenForScope(setCookieHeaders(linkRes), universe);
    if (!refreshToken) {
      throw new Error(
        `claim-universe link's consume (${linkRes.status}) set no refresh cookie for "${universe}": ` +
        `${(await linkRes.clone().text().catch(() => '')).slice(0, 200)}`,
      );
    }
    await acceptMembership(origin, refreshToken, universe, fetchImpl);
    const session: EmailSession = { refreshToken, authScope: universe, email, savedAt: new Date().toISOString() };
    return { session, usedLink: link, claimedFresh };
  } finally {
    waiter?.cleanup();
  }
  });

  // 2. Token at the universe, used to authorize the scope creations below it.
  let { accessToken, sub } = await refreshAccessToken(origin, session, universe, fetchImpl);

  // 3. Create each level below the universe the claim did not write. The galaxy (born with its
  //    `.dev` Star) through the facade, where this universe admin's dominion licenses it; a tenant
  //    Star by its own claim.
  if (galaxy && !claimedFresh) {
    await createGalaxyViaFacade({ baseUrl: scopeOriginFrom(origin, universe), accessToken, sub, universeGalaxyId: `${universe}.${galaxy}` });
  }
  if (star && star !== 'dev') {
    await foundTenantStar({ baseUrl: origin, star: scope, testToken, bypassToken, channel: options.channel, timeout });
  }

  // 4. Re-issue at the requested scope. `aud` becomes `scope`; reach stays the admin's.
  if (scope !== universe) {
    ({ accessToken, sub } = await refreshAccessToken(origin, session, scope, fetchImpl));
  }
  return { accessToken, sub, session, link: usedLink };
}

/**
 * Found a tenant Star the way a tenant does: its own `claim-star` by a fresh address, the emailed
 * link followed as sent, and that founder's Accept. Nothing is invited into a Star whose founder is
 * still pending, so a Star a caller means to use is founded whole. The founder is a stranger to
 * whoever asked, so their requests ride plain `fetch`, never the asker's cookie jar. Returns the
 * founder's address, or `null` when the Star was claimed already.
 */
export async function foundTenantStar(options: {
  baseUrl: string; star: string; testToken: string; bypassToken?: string;
  channel?: EmailLoginOptions['channel']; timeout?: number;
}): Promise<string | null> {
  const { star, testToken, bypassToken, timeout } = options;
  const origin = options.baseUrl.replace(/\/$/, '');
  const founder = uniqueTestEmail();
  const useEmail = (options.channel ?? 'email') === 'email';
  const waiter = useEmail ? waitForEmail({ testToken, to: founder, timeout: timeout ?? 60_000 }) : undefined;
  try {
    const claimed = await requestStarClaim({ baseUrl: origin, universeGalaxyStarId: star, email: founder, bypassToken });
    if (claimed === null) return null;
    const link = useEmail ? extractMagicLink(await waiter!.emailPromise) : claimed;
    if (!link) throw new Error(`claim-star for ${star} returned no link in test mode`);
    const clicked = await consumeLink(link); // the claim page's Accept
    if (!refreshTokenForScope(setCookieHeaders(clicked), star)) {
      throw new Error(`the founder's Accept (${clicked.status}) set no refresh cookie for "${star}"`);
    }
    return founder;
  } finally {
    waiter?.cleanup();
  }
}

/** The mesh client `createGalaxyViaFacade` calls through: nothing but the base, which is abstract. */
class FacadeCaller extends LumenizeClient {}

/**
 * Create an app through `NebulaAuthFacade.createGalaxy` — the one way a session creates a galaxy —
 * on a short-lived mesh client holding `accessToken`, which must carry dominion over the universe.
 * The client is the same identity as the token, for one call, so it renews nothing (`testing.md`).
 * An app that already exists is success, for provisioning.
 */
export async function createGalaxyViaFacade(options: {
  baseUrl: string; accessToken: string; sub: string; universeGalaxyId: string; WebSocket?: unknown;
}): Promise<void> {
  const { baseUrl, accessToken, sub, universeGalaxyId } = options;
  const client = new FacadeCaller({
    baseUrl: baseUrl.replace(/\/$/, ''),
    hostFromHostname: true,
    instanceName: `${sub}.${crypto.randomUUID().slice(0, 8)}`,
    accessToken,
    refresh: async () => ({ access_token: accessToken, sub }),
    ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
  } as ConstructorParameters<typeof LumenizeClient>[0]);
  try {
    await client.lmz.callAsync('AUTH_FACADE', undefined,
      client.ctn<NebulaAuthFacade>().createGalaxy(universeGalaxyId));
  } catch (e) {
    if ((e as { errorCode?: string }).errorCode !== 'slug_taken') throw e;
  } finally {
    client.disconnect();
  }
}

/**
 * The one-call path: real login, then an access token for `activeScope`
 * (defaults to the login scope). Use this wherever a test or harness previously
 * reached for `createNebulaTestToken`.
 *
 * Requires an identity to already exist at `authScope` — for a scope that does not
 * exist yet, use {@link provisionAndLogin}.
 */
export async function accessTokenViaEmail(
  options: EmailLoginOptions & { activeScope?: string },
): Promise<{ accessToken: string; sub: string; session: EmailSession }> {
  const session = await loginViaEmail(options);
  const { accessToken, sub } = await refreshAccessToken(
    options.baseUrl,
    session,
    options.activeScope ?? options.authScope,
    options.fetchImpl,
  );
  return { accessToken, sub, session };
}
