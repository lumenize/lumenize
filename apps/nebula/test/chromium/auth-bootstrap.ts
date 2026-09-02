/**
 * Auth bootstrap for the real-chromium harness — drives real magic-link email round-trips
 * end-to-end, browser-native (no `@lumenize/testing` Browser shim; chromium's own fetch + cookie jar
 * + WebSocket are used directly):
 *
 *   1. Test → /worker/auth/…                        (same-origin via proxy)
 *   2. wrangler-dev → Cloudflare Email Sending → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to test (waitForEmail)
 *   5. Test → GET <magic-link URL, host-rewritten to the proxy> → 302 sets the
 *      `Secure; SameSite=Strict` refresh cookie on the TEST PAGE's origin
 *
 * After this resolves, chromium holds the refresh cookie at `/worker/auth/<scope>/`, so a subsequent
 * `createNebulaClient({ baseUrl, authScope: scope, … })` mints its access JWT via the real
 * `/auth/<scope>/refresh-token` flow on connect (no pre-passed accessToken — it exercises the real
 * refresh path).
 *
 * No test-mode bypass and no synthetic mint — ADR-009 rung 1 throughout.
 *
 * ⚠️ **Why this cannot simply call `test/lib/email-login.ts`.** That module reads the refresh token
 * out of the `Set-Cookie` response header. In a browser `Set-Cookie` is not exposed to JS at all —
 * chromium stores it implicitly and replays it via `credentials: 'include'`. So the same flow has to
 * be re-expressed here against the implicit jar. Keep the two in step.
 *
 * The magic-link host rewrite (step 5) is the other chromium-specific bit: the auth layer embeds
 * wrangler-dev's own host in the link, but the cookie must be set on the test page's origin, so the
 * link is rewritten to the same-origin proxy path before clicking.
 */

import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';

interface BootstrapAdminOptions {
  /** Same-origin proxy prefix resolved against the test page origin, e.g. `${location.origin}/worker`. */
  baseUrl: string;
  /** The STAR scope to authenticate at — 3 segments, e.g. 'acme-abc.app.tenant-a'. */
  scope: string;
  /** Email to register / log in. Must be `test@lumenize.io` so the deployed email-test Worker receives it. */
  email: string;
  /** TEST_TOKEN for authenticating with the deployed email-test DO. */
  testToken: string;
}

/**
 * Run one open claim (`claim-universe` or `claim-star`) and click the emailed link, leaving the
 * refresh cookie in chromium's jar at `/worker/auth/{scope}/`.
 *
 * A 409 means the scope is already claimed by this email — an ordinary login link for the existing
 * identity is requested instead. That is legitimate, not an error: unlike a `create-*` scope, a
 * claimed one HAS an identity to log in as.
 */
async function claimAndClick(
  baseUrl: string,
  endpoint: 'claim-universe' | 'claim-star',
  scope: string,
  body: Record<string, string>,
  email: string,
  testToken: string,
): Promise<void> {
  // Arm the listener BEFORE triggering the send. `instance: scope` routes only this hop's email here
  // (via the `X-Lumenize-Auth-Instance` header the sender stamps), so the universe hop and the star
  // hop below never pick up each other's link, and concurrent runs don't collide.
  let waiter = waitForEmail({ testToken, instance: scope });
  try {
    const res = await fetch(`${baseUrl}/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`${endpoint} failed: ${res.status} ${await res.text()}`);
    }
    if (res.status === 409) {
      // ⚠️ **The fallback login is SCOPE-LESS, so its mail carries no scope tag** — the waiter armed
      // above can never match it, and would sit out its full timeout looking like a slow send. Retire
      // it and arm one for `_scopeless` before the request goes out. (Leaking the first would also
      // keep Node's event loop alive past the verdict, which is its own confusing hang.)
      waiter.cleanup();
      waiter = waitForEmail({ testToken, instance: '_scopeless', to: email });
      const login = await fetch(`${baseUrl}/auth/email-magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        credentials: 'include',
      });
      if (!login.ok) {
        throw new Error(`email-magic-link (after 409) failed: ${login.status} ${await login.text()}`);
      }
    }

    const receivedEmail = await waiter.emailPromise;
    if (receivedEmail.to?.[0]?.address !== email) {
      throw new Error(`Email recipient mismatch: expected '${email}', got '${receivedEmail.to?.[0]?.address}'`);
    }

    // Rewrite the embedded wrangler-dev host to the same-origin proxy so the 302's Set-Cookie binds
    // to the test page origin (and thus rides the follow-up refresh-token POST). `redirect: 'manual'`
    // — chromium returns an opaqueredirect (status 0) for cross-fetch manual redirects; cookies are
    // saved either way.
    const magicLinkUrl = extractMagicLink(receivedEmail).replace(/^https?:\/\/[^/]+/, baseUrl);
    const clickResponse = await fetch(magicLinkUrl, { redirect: 'manual', credentials: 'include' });
    if (clickResponse.status !== 302 && clickResponse.status !== 0) {
      throw new Error(`Magic-link click expected 302 (or 0 opaqueredirect), got ${clickResponse.status}`);
    }
  } finally {
    waiter.cleanup();
  }
}

/**
 * Provision a tenant Star and log in AS ITS FOUNDER, so chromium's jar holds the refresh cookie at
 * `/worker/auth/${scope}/` and the minted token carries an **exact-star** `authScope`.
 *
 * **Re-grounded onto `claim-star` (2026-07-25).** This used to POST `email-magic-link` at `scope` and
 * rely on "the first email registered at a scope becomes its admin" — a login-time mint that was
 * deliberately removed (identity mint is authority-point-only; the registry says outright *"NEVER
 * call from a login path"*). In between, the link was issued and emailed fine and then rejected on
 * consumption — `resolveConsume` → no memberships → no session cookie — which
 * is what reddened this lane. `claim-star` mints the star-scoped admin and emails the link in one open call.
 *
 * The universe and galaxy above still have to exist and only their own admin may create them, so
 * steps 1–2 remain a climb; step 3 is the new capability.
 */
export async function bootstrapAdmin(
  options: BootstrapAdminOptions,
): Promise<{ universe: string; galaxy: string }> {
  const { baseUrl, scope, email, testToken } = options;
  const parts = scope.split('.');
  if (parts.length !== 3) {
    throw new Error(`chromium bootstrapAdmin needs a 3-segment star scope, got "${scope}"`);
  }
  const [universe, galaxy] = parts;

  // 1. Claim the universe (open) — the universe admin that will authorize the galaxy below it.
  await claimAndClick(baseUrl, 'claim-universe', universe, { slug: universe, email }, email, testToken);

  // 2. A universe-scoped token, used only to create the galaxy. `create-galaxy` is admin-gated over
  //    the parent, and the universe admin is admin — so this admin authorizes its own tree.
  const refresh = await fetch(`${baseUrl}/auth/${universe}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: universe }),
    credentials: 'include',
  });
  if (!refresh.ok) {
    throw new Error(`refresh-token at ${universe} failed: ${refresh.status} ${await refresh.text()}`);
  }
  const { access_token: accessToken } = await refresh.json() as { access_token: string };

  const galaxyRes = await fetch(`${baseUrl}/auth/create-galaxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ universeGalaxyId: `${universe}.${galaxy}` }),
    credentials: 'include',
  });
  // 409 = already exists, which is success for provisioning purposes.
  if (!galaxyRes.ok && galaxyRes.status !== 409) {
    throw new Error(`create-galaxy failed: ${galaxyRes.status} ${await galaxyRes.text()}`);
  }

  // 3. Claim the star as the tenant — open, no admin in the loop, no token needed. This is the hop
  //    that mints an identity AT `scope`, which is what makes the cookie there possible at all.
  await claimAndClick(
    baseUrl, 'claim-star', scope, { universeGalaxyStarId: scope, email }, email, testToken,
  );

  // Both cookies are now in the jar — `/worker/auth/{universe}/` and `/worker/auth/{scope}/`. A
  // client picks which identity it gets purely by its `authScope`. Callers that need to write ABOVE
  // the star (installing the app's ontology on the Galaxy, say) must use the universe one: the star
  // star-scoped admin holds an exact-star pattern and is inert at every ancestor, by design (ADR-015).
  return { universe, galaxy: `${universe}.${galaxy}` };
}
