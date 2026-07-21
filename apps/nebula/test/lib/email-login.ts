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
 * workerd (vitest-pool-workers test-apps). Anything that needs the filesystem —
 * e.g. the harness's stored-session cache — layers on top rather than living
 * here.
 *
 * The loop costs ~1.4 s standalone and ~0.9 s marginal inside a running suite
 * (measured 2026-07-21, `tasks/email-latency-cf-vs-resend.md`). That is cheap
 * enough that speed is never a reason to drop to a lower rung.
 */
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';

/** Cookie-aware fetch. `@lumenize/testing`'s `Browser` satisfies this, as does global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface EmailLoginOptions {
  /**
   * Where to send auth requests — a wrangler-dev origin, `http://localhost` for
   * an in-process pool-workers Worker, or a deployed origin. Trailing slash ok.
   */
  baseUrl: string;
  /** The `authScope` path segment: `/auth/<authScope>/…`. Also the email `instance` filter. */
  authScope: string;
  /** TEST_TOKEN for the deployed email-test Worker. */
  testToken: string;
  /**
   * Identity to log in. Defaults to a fresh `test-<uuid>@lumenize.io`, which is
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
  /** Turnstile bypass token. Omit where Turnstile is off — it is, in local dev. */
  bypassToken?: string;
  /** Email-wait ceiling. Default 60 s (the loop is ~1.4 s; this is slack, not an expectation). */
  timeout?: number;
}

export interface EmailSession {
  /** The `refresh-token` cookie value — a real credential. NEVER log it. */
  refreshToken: string;
  /** The authScope the refresh cookie is Path-bound to. */
  authScope: string;
  email: string;
  savedAt: string;
}

const BYPASS_HEADER = 'x-lumenize-turnstile-bypass';

function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

/** Read Set-Cookie across runtimes — `getSetCookie()` in Node/workerd, single header elsewhere. */
function setCookieHeaders(res: Response): string[] {
  const multi = res.headers.getSetCookie?.();
  if (multi && multi.length > 0) return multi;
  const single = res.headers.get('Set-Cookie');
  return single ? [single] : [];
}

/**
 * Log in for real: POST the magic-link request → catch the email via the
 * email-test Worker → GET the link → capture the `refresh-token` cookie.
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
  const waiter = waitForEmail({ testToken, instance: authScope, to: email, timeout });
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bypassToken) headers[BYPASS_HEADER] = bypassToken;

    const res = await fetchImpl(`${origin}/auth/${authScope}/email-magic-link`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      // 403 here usually means Turnstile blocked us — a missing/stale bypassToken
      // against an environment that has Turnstile ON.
      throw new Error(`email-magic-link ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const link = extractMagicLink(await waiter.emailPromise);
    // Re-point the link at `baseUrl`. LumenizeAuth embeds the configured ISSUER origin
    // (e.g. nebula.lumenize.com) in the emailed link, which is NOT where we're driving
    // when that's a local wrangler-dev or a proxy — GETting it as-sent leaves the stack
    // under test entirely and comes back a 301 with no cookie. Only the host changes; the
    // `one_time_token` query param is what carries the grant. No-op against prod, where
    // the issuer origin already equals baseUrl.
    const target = new URL(origin);
    const localLink = new URL(link);
    localLink.protocol = target.protocol;
    localLink.host = target.host;

    // `manual` so we can read Set-Cookie: the 302 Location is a client-side route.
    const linkRes = await fetchImpl(localLink.toString(), { redirect: 'manual' });
    const refreshToken = cookieValue(setCookieHeaders(linkRes), 'refresh-token');
    if (!refreshToken) {
      // Say WHY, not just "no cookie". `Location` carries the auth layer's own error code
      // when the link was REJECTED (`?error=invalid_token` = the token was not found or was
      // already consumed), while the presence of other Set-Cookie names separates "server
      // never set it" from "our client dropped it". Report both; don't guess between them.
      const others = setCookieHeaders(linkRes).map((c) => c.split('=')[0]).join(', ') || '(none)';
      throw new Error(
        `magic-link GET (${linkRes.status}) set no refresh-token cookie — ` +
        `Location=${linkRes.headers.get('Location') ?? '(none)'}; Set-Cookie names=${others}; ` +
        `origin=${target.protocol}//${target.host}`,
      );
    }

    return { refreshToken, authScope, email, savedAt: new Date().toISOString() };
  } finally {
    waiter.cleanup();
  }
}

/**
 * Exchange a refresh token for an access token whose `aud` is `activeScope`.
 * Not Turnstile-gated, so no bypass token is involved.
 */
export async function refreshAccessToken(
  baseUrl: string,
  session: Pick<EmailSession, 'refreshToken' | 'authScope'>,
  activeScope: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accessToken: string; sub: string }> {
  const origin = baseUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${origin}/auth/${session.authScope}/refresh-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `refresh-token=${session.refreshToken}`,
    },
    body: JSON.stringify({ activeScope }),
  });
  if (!res.ok) throw new Error(`refresh-token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { access_token, sub } = (await res.json()) as { access_token: string; sub: string };
  return { accessToken: access_token, sub };
}

/**
 * Provision a scope and log in as its real founder — the rung-1 path for a scope
 * that does not exist yet.
 *
 * Why this and not just `loginViaEmail`: **login never mints an identity.** Identity
 * mint is authority-point-only (`nebula-auth-registry.ts` says outright *"NEVER call
 * from a login path"*), so a magic link for a scope with no identity is issued, emailed,
 * and then rejected on consumption — `302 /app?error=invalid_token`, no cookie. The one
 * open, founder-minting entry point today is `claim-universe`, which mints the founder
 * with `isAdmin: true` before sending the link.
 *
 * So: claim the **universe**, log in there for real, then create the galaxy/star beneath
 * it with that founder's token. The returned token's universe-founder reach covers every
 * scope below, which is what lets a caller drive a star it never logged into directly —
 * the same shape prod uses (`prodLogin` at `nebula-platform`, then refresh at the target).
 *
 * ⚠️ Logging in *directly* at a fresh star is a different thing and is NOT possible yet:
 * `createStar` writes a `Scopes` row with no founder. That is open Star self-signup —
 * `tasks/nebula-star-founder-provisioning.md`, tracked by the `it.skip('claim-star: …')`
 * in `packages/nebula-auth/test/nebula-auth-routes.test.ts`.
 *
 * @param scope 1–3 dot-separated segments (`u`, `u.g`, or `u.g.s`). Each level below the
 *              universe is created in order.
 */
export async function provisionAndLogin(
  options: Omit<EmailLoginOptions, 'authScope'> & { scope: string },
): Promise<{ accessToken: string; sub: string; session: EmailSession }> {
  const { scope, baseUrl, testToken, fetchImpl = fetch, bypassToken, timeout } = options;
  const email = options.email ?? uniqueTestEmail();
  const origin = baseUrl.replace(/\/$/, '');
  const [universe, galaxy, star] = scope.split('.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bypassToken) headers[BYPASS_HEADER] = bypassToken;

  // 1. Claim the universe. Open + Turnstile-only, and the ONLY thing here that mints an
  //    identity — it also sends the magic link, so no separate email-magic-link call.
  const waiter = waitForEmail({ testToken, instance: universe, to: email, timeout: timeout ?? 60_000 });
  let session: EmailSession;
  try {
    const claim = await fetchImpl(`${origin}/auth/claim-universe`, {
      method: 'POST', headers, body: JSON.stringify({ slug: universe, email }),
    });
    if (!claim.ok) {
      throw new Error(`claim-universe ${claim.status}: ${(await claim.text()).slice(0, 200)}`);
    }
    const link = extractMagicLink(await waiter.emailPromise);
    const target = new URL(origin);
    const localLink = new URL(link);
    localLink.protocol = target.protocol;
    localLink.host = target.host;
    const linkRes = await fetchImpl(localLink.toString(), { redirect: 'manual' });
    const refreshToken = cookieValue(setCookieHeaders(linkRes), 'refresh-token');
    if (!refreshToken) {
      throw new Error(
        `claim-universe magic-link GET (${linkRes.status}) set no refresh-token cookie — ` +
        `Location=${linkRes.headers.get('Location') ?? '(none)'}`,
      );
    }
    session = { refreshToken, authScope: universe, email, savedAt: new Date().toISOString() };
  } finally {
    waiter.cleanup();
  }

  // 2. Token at the universe, used to authorize the scope creations below it.
  let { accessToken, sub } = await refreshAccessToken(origin, session, universe, fetchImpl);

  // 3. Create each level below the universe. Both endpoints are admin-gated over the
  //    parent, and the universe founder is admin — so this founder authorizes its own tree.
  const levels: Array<[string, string]> = [];
  if (galaxy) levels.push(['create-galaxy', `${universe}.${galaxy}`]);
  if (star) levels.push(['create-star', `${universe}.${galaxy}.${star}`]);
  for (const [endpoint, id] of levels) {
    const key = endpoint === 'create-galaxy' ? 'universeGalaxyId' : 'universeGalaxyStarId';
    const res = await fetchImpl(`${origin}/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ [key]: id }),
    });
    // 409 = already exists, which is success for provisioning purposes.
    if (!res.ok && res.status !== 409) {
      throw new Error(`${endpoint} ${res.status} for ${id}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  // 4. Re-issue at the requested scope. `aud` becomes `scope`; reach stays the founder's.
  if (scope !== universe) {
    ({ accessToken, sub } = await refreshAccessToken(origin, session, scope, fetchImpl));
  }
  return { accessToken, sub, session };
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
