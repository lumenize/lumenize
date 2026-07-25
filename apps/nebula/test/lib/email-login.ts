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
  /**
   * Where the magic link comes from — the ADR-009 rung, made explicit:
   *
   * - `'email'` (default, **rung 1**) — the real thing: the server sends, the deployed
   *   email-test Worker receives, the link arrives over a WebSocket push.
   * - `'test-mode'` (**rung 2**) — the server returns `magicLinkUrl` in the response body
   *   instead of sending. Requires `NEBULA_AUTH_TEST_MODE=true` on the worker.
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

// ─── Shared primitives ────────────────────────────────────────────────────────
// The vitest-free core. `test/test-helpers.ts` builds its `expect`-flavoured surface
// on top of these instead of re-implementing the HTTP shapes — same endpoints, same
// 409 semantics, same host rewrite, one place.
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
 * Point a magic link at `baseUrl`. The auth layer embeds its configured ISSUER origin in
 * the link, which is not where we're driving against a local wrangler-dev or a proxy —
 * GETting it as-sent leaves the stack under test. Only the host changes; the
 * `one_time_token` query param carries the grant. No-op when the origins already match.
 */
export function pointLinkAt(baseUrl: string, link: string): string {
  const target = new URL(baseUrl.replace(/\/$/, ''));
  const out = new URL(link);
  out.protocol = target.protocol;
  out.host = target.host;
  return out.toString();
}

/**
 * POST `claim-universe` — the one open, founder-minting entry point. Returns the magic-link
 * URL in test mode, `undefined` in email mode (the link arrives by email instead), or
 * `null` when the slug is **already claimed** (409).
 *
 * ⚠️ 409 is legitimate and common, not an error: one founder backing several clients claims
 * once, then re-logs-in. Callers fall through to an ordinary login. It is NOT silently
 * swallowed — if the universe was claimed by a *different* email, no identity exists for
 * this one and the login fails visibly at consume.
 */
export async function requestUniverseClaim(options: {
  baseUrl: string; universe: string; email: string;
  fetchImpl?: FetchLike; bypassToken?: string;
}): Promise<string | null | undefined> {
  const { baseUrl, universe, email, fetchImpl = fetch, bypassToken } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bypassToken) headers[BYPASS_HEADER] = bypassToken;
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/auth/claim-universe`, {
    method: 'POST', headers, body: JSON.stringify({ slug: universe, email }),
  });
  if (res.status === 409) return null;
  if (!res.ok) {
    throw new Error(`claim-universe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { magicLinkUrl?: string }).magicLinkUrl;
}

/**
 * POST `email-magic-link` for an identity that already exists at `authScope`.
 * Returns the link URL in test mode, `undefined` in email mode.
 */
export async function requestMagicLink(options: {
  baseUrl: string; authScope: string; email: string;
  fetchImpl?: FetchLike; bypassToken?: string;
}): Promise<string | undefined> {
  const { baseUrl, authScope, email, fetchImpl = fetch, bypassToken } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bypassToken) headers[BYPASS_HEADER] = bypassToken;
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/auth/${authScope}/email-magic-link`, {
    method: 'POST', headers, body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    // 403 here usually means Turnstile blocked us — a missing/stale bypassToken.
    throw new Error(`email-magic-link ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { magicLinkUrl?: string }).magicLinkUrl;
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
    await requestMagicLink({ baseUrl: origin, authScope, email, fetchImpl, bypassToken });

    const link = pointLinkAt(origin, extractMagicLink(await waiter.emailPromise));
    // `manual` so we can read Set-Cookie: the 302 Location is a client-side route.
    const linkRes = await fetchImpl(link, { redirect: 'manual' });
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
        `origin=${new URL(origin).origin}`,
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
 * ⚠️ Logging in *directly* at a fresh star is a different thing, and `create-star` cannot get you
 * there — it writes a `Scopes` row with no founder, so there is no identity to log in as. The path
 * that can is the open `claim-star` self-signup, which mints an `isAdmin` founder at the star scope
 * and emails it a claim link (`tasks/nebula-star-founder-provisioning.md`). Re-ground this helper
 * onto it rather than climbing from the universe (that task's Phase 4).
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
  // 1. Claim the universe. Open + Turnstile-only, and the ONLY thing here that mints an
  //    identity — it also issues the magic link, so no separate email-magic-link call.
  const useEmail = (options.channel ?? 'email') === 'email';
  const waiter = useEmail
    ? waitForEmail({ testToken, instance: universe, to: email, timeout: timeout ?? 60_000 })
    : undefined;
  let session: EmailSession;
  try {
    const claimed = await requestUniverseClaim({ baseUrl: origin, universe, email, fetchImpl, bypassToken });
    let rawLink: string | undefined;
    if (claimed === null) {
      // Already claimed — fall through to an ordinary login for the existing identity.
      rawLink = await requestMagicLink({ baseUrl: origin, authScope: universe, email, fetchImpl, bypassToken });
    } else {
      rawLink = claimed;
    }
    let link: string;
    if (useEmail) {
      link = pointLinkAt(origin, extractMagicLink(await waiter!.emailPromise));
    } else {
      if (!rawLink) {
        throw new Error(
          "channel 'test-mode' but no magicLinkUrl came back — " +
          'NEBULA_AUTH_TEST_MODE must be "true" on the worker for this channel',
        );
      }
      link = pointLinkAt(origin, rawLink);
    }
    const linkRes = await fetchImpl(link, { redirect: 'manual' });
    const refreshToken = cookieValue(setCookieHeaders(linkRes), 'refresh-token');
    if (!refreshToken) {
      throw new Error(
        `claim-universe magic-link GET (${linkRes.status}) set no refresh-token cookie — ` +
        `Location=${linkRes.headers.get('Location') ?? '(none)'}`,
      );
    }
    session = { refreshToken, authScope: universe, email, savedAt: new Date().toISOString() };
  } finally {
    waiter?.cleanup();
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
