/**
 * **The host is the scope: each host gets its own page, its own token, its own framing, and no
 * page anywhere reads what belongs to another.**
 *
 * The superuser **S** is the fixture throughout: S's platform membership is the root of the tree, so
 * the refresh would mint for any scope host, and any host S is refused on is refused for the host's
 * sake rather than S's.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **A page gets a token for its own host and no other.** S's pages on a galaxy's host and a
 *     universe's each get a token whose `aud` is that host's scope, with CORS naming that page's
 *     origin alone; a page on the platform host gets nothing. *Reds if the refresh mints for a host
 *     that names no scope.*
 *  2. **A cookie without the `__Host-` prefix is not a candidate.** S's raw refresh value, planted
 *     from a scope host into a fresh browser as `refresh-token.{scope}` on `Domain=lumenize.localhost`,
 *     lands in that browser's jar and mints nothing. *Reds if the unprefixed name is accepted — the
 *     plant would sign a browser in that never logged in.*
 *  3. **Every host's page load reaches the page it names**, through vite's shared parse: Home and the
 *     login on the platform host, Studio on a universe's and a galaxy's host, the Worker's answer on
 *     a Star's host, and the apex redirecting to the platform host. *Reds if vite stops reading the
 *     host through the parse — a Star's host then gets Studio.*
 *  4. **Each page is framed only by the origin it names**, asserted on the Worker's own answers:
 *     `frame-ancestors 'none'` on the platform host, a universe's page and Studio, and the galaxy's
 *     Studio origin on its dev Star's host. *Reds if the Worker's page step stops stamping it.*
 *  5. **No scope-host page reads Home's data.** From S's Studio, a credentialed request to
 *     `home-summary` and to `pending-membership` is refused by the same-origin rule, matched by its
 *     message, with no `Access-Control-Allow-Origin`; Home itself, same-origin, reads it. *Reds if
 *     the rule refuses only `cross-site`, or CORS is answered router-wide again.*
 *  6. **A minted link follows the request it was minted from.** A magic link and an invite, each
 *     requested on the Worker's port and on vite's, each name the platform host at that port. *Reds
 *     if a link is built from a constant origin.*
 *  7. **A `return_to` off the site is refused where it is stored.** `email-magic-link` answers 400 to
 *     a scheme-relative URL, a `javascript:` and a `data:` URL, and a host the parse refuses; a
 *     scope host's URL is kept, and the letter's Continue lands there. *Reds if only the login page
 *     validates it.*
 *  8. **A stored picture renders on every host.** Uploaded on a tenant's host, its stored value is a
 *     relative path, and an `<img>` of it on the platform host and on a galaxy's host loads from
 *     each page's own host. *Reds if the upload answers an absolute URL.*
 *
 * `needsContainer = false` — no app is built; the dev Star's host answers without one.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { StudioClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Page } from 'playwright';
import type { DevStack } from '../lib/harness';
import { inviteViaMesh, readDevVar, scopeUrlOf, waitForHost, NEW_HOST_TIMEOUT_MS, superuserEmail } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite } from '../lib/browser';
import {
  provisionStarAdmin, refreshAccessToken, requestUniverseClaim, requestMagicLink, consumeLink,
} from '../../test/lib/email-login';

const SUPERUSER = superuserEmail('hosts-superuser@lumenize-test.dev');

export const needsContainer = false;
export const bootVars = { AUTH_BOOTSTRAP_EMAIL: SUPERUSER };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('hf');
  const galaxy = `${universe}.crm`;

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const origin = vite.viteBaseUrl;
  try {
    /** The one letter a send produces, armed before the send and filtered by its unique recipient. */
    const letterTo = async (to: string, send: () => Promise<unknown>): Promise<string> => {
      const waiter = waitForEmail({ testToken, to, timeout: 120_000 });
      try {
        await send();
        const mail = await waiter.emailPromise;
        const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
        return href ? href.replace(/&amp;/g, '&') : extractMagicLink(mail);
      } finally {
        waiter.cleanup();
      }
    };

    // ── The fixture: S, signed in, holding the platform membership beside an account ───────────
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(await letterTo(SUPERUSER, () =>
      requestUniverseClaim({ baseUrl: origin, universe, appSlug: 'crm', email: SUPERUSER })), { waitUntil: 'domcontentloaded' });
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('consent-nickname').fill('Sue');
    await page.getByTestId('consent-accept').click();
    await page.waitForURL((u) => u.origin === vite.scopeUrl(galaxy), { timeout: NEW_HOST_TIMEOUT_MS });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    // Pending on every local boot. A deployed target keeps its superuser between runs, so after the
    // first run the platform membership is accepted already and its row has nothing to open.
    const platformRow = page.getByRole('button', { name: /_platform/ });
    await platformRow.waitFor({ state: 'visible', timeout: 30_000 });
    if (await platformRow.isEnabled()) {
      await platformRow.click();
      await page.getByTestId('consent-checkbox').check();
      await page.getByTestId('consent-nickname').fill('Sue');
      await page.getByTestId('consent-accept').click();
      await page.getByTestId('consent-checkbox').waitFor({ state: 'detached', timeout: 30_000 });
    }

    // ── LIMB 1: a page gets a token for its own host and no other ──────────────────────────────
    /** Load `host`'s page and read the refresh its client sends: the token's `aud`, and the CORS. */
    const refreshOn = async (host: string) => {
      const answered = page.waitForResponse((r) => r.url() === `${origin}/auth/refresh-token` && r.request().method() === 'POST');
      await page.goto(`${vite.scopeUrl(host)}/`, { waitUntil: 'domcontentloaded' });
      const res = await answered;
      const body = await res.json() as { access_token?: string };
      return {
        aud: body.access_token ? (parseJwtUnsafe(body.access_token)!.payload as { aud: string }).aud : undefined,
        cors: res.headers()['access-control-allow-origin'],
      };
    };
    for (const host of [galaxy, universe]) {
      assert.deepEqual(await refreshOn(host), { aud: host, cors: vite.scopeUrl(host) },
        `${host}'s page must get a token for ${host} alone, with CORS naming its own origin`);
    }
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const onPlatform = await page.evaluate(async () => {
      const res = await fetch('/auth/refresh-token', { method: 'POST' });
      return { status: res.status, body: await res.text() };
    });
    assert.equal(onPlatform.status, 403, 'a page on the platform host must get no token');
    assert.doesNotMatch(onPlatform.body, /access_token/, 'the refusal must carry no token');
    console.error('  ✓ limb 1 — each scope host got its own token and CORS; the platform host got none');

    // ── LIMB 2: a cookie without the __Host- prefix is not a candidate ─────────────────────────
    const raw = (await context.cookies()).find((c) => c.name === `__Host-refresh-token.${universe}`);
    assert.ok(raw, "S's browser must hold the account's refresh cookie");
    const planter = await (await browser.newContext()).newPage();
    await planter.goto(`${vite.scopeUrl(`${galaxy}.dev`)}/`, { waitUntil: 'domcontentloaded' });
    // The site's own domain, which every host shares: `lumenize.localhost` locally.
    const site = new URL(origin).hostname.replace(/^platform\./, '');
    await planter.evaluate(([name, value, domain]) => {
      document.cookie = `${name}=${value}; Domain=${domain}; Path=/`;
    }, [`refresh-token.${universe}`, raw.value, site]);
    assert.ok((await planter.context().cookies()).some((c) => c.name === `refresh-token.${universe}`),
      'the plant must be in the fresh browser\'s jar before the refresh — the positive control');
    const planted = planter.waitForResponse((r) => r.url() === `${origin}/auth/refresh-token`);
    await planter.evaluate((url) => fetch(url, { method: 'POST', credentials: 'include' }).catch(() => {}), `${origin}/auth/refresh-token`);
    assert.equal((await planted).status(), 401, 'an unprefixed refresh cookie must mint nothing');
    await planter.context().close();
    console.error('  ✓ limb 2 — the planted unprefixed cookie landed in the jar and minted nothing');

    // ── LIMB 3: every host's page load reaches the page it names ───────────────────────────────
    const load = (url: string) => fetch(url, { headers: { Accept: 'text/html' }, redirect: 'manual' });
    // Each page by its title, which the build keeps: vite serves the source and a deployment the bundle.
    const studio = '<title>Lumenize Studio</title>';
    const authApp = '<title>Lumenize</title>';
    for (const [url, entry, what] of [
      [`${origin}/`, authApp, 'Home'], [`${origin}/auth/login`, authApp, 'the login'],
      [`${vite.scopeUrl(universe)}/`, studio, "a universe's page"], [`${vite.scopeUrl(galaxy)}/`, studio, 'Studio'],
    ] as const) {
      const res = await load(url);
      assert.equal(res.status, 200, `${what} must load (${res.status})`);
      assert.ok((await res.text()).includes(entry), `${what} must be the entry that names it`);
    }
    const star = await load(`${vite.scopeUrl(`${galaxy}.dev`)}/`);
    assert.ok(!(await star.text()).includes(studio), "a Star's host must never get Studio");
    const apex = await load(`${origin.replace('//platform.', '//')}/`);
    assert.equal(apex.status, 302, 'the apex must redirect');
    assert.equal(apex.headers.get('location'), `${origin}/`, 'the apex must redirect to the platform host');
    console.error('  ✓ limb 3 — every host loaded the page it names');

    // ── LIMB 4: each page is framed only by the origin it names ────────────────────────────────
    const framing = async (url: string) => (await fetch(url, { headers: { Accept: 'text/html' } })).headers.get('content-security-policy');
    for (const url of [`${stack.baseUrl}/`, `${scopeUrlOf(stack, universe)}/`, `${scopeUrlOf(stack, galaxy)}/`]) {
      assert.equal(await framing(url), "frame-ancestors 'none'", `${url} must be unframeable`);
    }
    assert.equal(await framing(`${scopeUrlOf(stack, `${galaxy}.dev`)}/`), `frame-ancestors ${scopeUrlOf(stack, galaxy)}`,
      "the dev Star's host may be framed by its galaxy's Studio alone");
    console.error("  ✓ limb 4 — 'none' on the platform, universe and Studio pages; the galaxy's Studio on the dev Star's");

    // ── LIMB 5: no scope-host page reads Home's data ───────────────────────────────────────────
    // In the browser, Studio's credentialed read of Home's routes fails outright: the page reads
    // nothing. The answer itself is CORS-blocked there, so the same request is then sent from Node
    // as Chromium sent it — `Origin`, `Sec-Fetch-Site: same-site`, S's cookies — to read the refusal.
    await page.goto(`${vite.scopeUrl(galaxy)}/`, { waitUntil: 'domcontentloaded' });
    const cookies = (await context.cookies()).filter((c) => c.name.startsWith('__Host-refresh-token.'))
      .map((c) => `${c.name}=${c.value}`).join('; ');
    for (const route of ['home-summary', 'pending-membership']) {
      const read = await page.evaluate((url) => fetch(url, { method: 'POST', credentials: 'include', body: '{}' })
        .then((r) => `read ${r.status}`, (e: Error) => `failed: ${e.name}`), `${origin}/auth/${route}`);
      assert.equal(read, 'failed: TypeError', `Studio's page must read nothing from ${route}, got ${read}`);
      const res = await fetch(`${stack.baseUrl}/auth/${route}`, {
        method: 'POST', body: '{}',
        headers: { Origin: scopeUrlOf(stack, galaxy), 'Sec-Fetch-Site': 'same-site', Cookie: cookies },
      });
      assert.equal(res.status, 403, `${route} must refuse a scope-host page`);
      assert.match(await res.text(), /Only a page on this host may call this route \(Sec-Fetch-Site: same-site\)/,
        `${route}'s refusal must be the same-origin rule's`);
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${route} must answer no CORS`);
    }
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const home = await page.evaluate(async () => (await fetch('/auth/home-summary', { method: 'POST', body: '{}' })).status);
    assert.equal(home, 200, 'Home, same-origin, must read its summary — the positive control');
    console.error("  ✓ limb 5 — Studio's credentialed reads of Home's routes were refused; Home read its own");

    // ── LIMB 6: a minted link follows the request it was minted from ───────────────────────────
    const viaWorker = await letterTo(SUPERUSER, () => requestMagicLink({ baseUrl: stack.baseUrl, email: SUPERUSER }));
    const viaVite = await letterTo(SUPERUSER, () => requestMagicLink({ baseUrl: origin, email: SUPERUSER }));
    assert.equal(new URL(viaWorker).origin, stack.baseUrl, "a link requested on the Worker's port names it");
    assert.equal(new URL(viaVite).origin, origin, "a link requested on vite's port names it");
    const atGalaxy = await refreshAccessToken(stack.baseUrl, { refreshToken: raw.value, authScope: universe }, galaxy);
    const invitee = uniqueTestEmail();
    const invitedViaWorker = await letterTo(invitee, () => inviteViaMesh(stack, atGalaxy, galaxy, [{ email: invitee }]));
    assert.equal(new URL(invitedViaWorker).origin, stack.baseUrl, "an invite sent from the Worker's port names it");
    const viteInvitee = uniqueTestEmail();
    const invitedViaVite = await letterTo(viteInvitee, () =>
      inviteViaMesh(stack, atGalaxy, galaxy, [{ email: viteInvitee }], undefined, { scopeUrl: vite.scopeUrl, platformOrigin: origin }));
    assert.equal(new URL(invitedViaVite).origin, origin, "an invite sent from vite's port names it");
    console.error("  ✓ limb 6 — magic links and invites each named the platform host at the port they were requested on");

    // ── LIMB 7: a return_to off the site is refused where it is stored ─────────────────────────
    const ask = (returnTo: string) => fetch(`${stack.baseUrl}/auth/email-magic-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPERUSER, return_to: returnTo }),
    });
    for (const bad of ['//evil.example/', 'javascript:alert(1)', 'data:text/html,hi', `${scopeUrlOf(stack, 'a.b.c.d')}/`]) {
      const res = await ask(bad);
      assert.equal(res.status, 400, `return_to ${bad} must be refused where it is stored`);
      assert.equal((await res.json() as { error?: string }).error, 'invalid_return_to', `return_to ${bad}: refused by name`);
    }
    const kept = `${scopeUrlOf(stack, galaxy)}/?view=kept`;
    const keptLink = await letterTo(SUPERUSER, async () => assert.equal((await ask(kept)).status, 200, 'a scope host URL must be kept'));
    const continued = await consumeLink(keptLink);
    assert.equal((await continued.json() as { redirect?: string }).redirect, kept, "the letter's Continue must land on the kept return_to");
    console.error('  ✓ limb 7 — four off-site return_to values were refused; a scope host URL was kept and honoured');

    // ── LIMB 8: a stored picture renders on every host ─────────────────────────────────────────
    // A tenant under an account of its own, founded by its own claim — any tenant's host will do.
    const tenant = `${universe}t.crm.t1`;
    const founder = await provisionStarAdmin({ baseUrl: stack.baseUrl, scope: tenant, testToken });
    await waitForHost(scopeUrlOf(stack, tenant)); // its galaxy is new, so on a deployed target its certificate is too
    const shim = new Browser();
    const tenantCtx = shim.context(scopeUrlOf(stack, tenant));
    const tenantClient = new StudioClient({
      baseUrl: scopeUrlOf(stack, tenant), platformOrigin: stack.baseUrl, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      accessToken: founder.accessToken, instanceName: `${founder.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: tenantCtx.fetch, sessionStorage: tenantCtx.sessionStorage, BroadcastChannel: tenantCtx.BroadcastChannel,
    });
    let stored: string;
    try {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
      stored = await tenantClient.uploadProfilePicture(new Blob([png], { type: 'image/png' }));
    } finally {
      try { tenantClient[Symbol.dispose](); } catch { /* already disposed */ }
      tenantCtx.close();
    }
    assert.match(stored, /^\/pictures\/[0-9a-f-]{36}\.png$/, `the stored picture must be a relative path, got ${stored}`);
    const rendersOn = async (p: Page, url: string) => {
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      return p.evaluate((src) => new Promise<{ src: string; width: number }>((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve({ src: img.src, width: img.naturalWidth });
        img.onerror = () => resolve({ src: img.src, width: 0 });
        img.src = src;
        document.body.appendChild(img);
      }), stored);
    };
    for (const url of [`${origin}/`, `${vite.scopeUrl(galaxy)}/`]) {
      const shown = await rendersOn(page, url);
      assert.equal(new URL(shown.src).origin, new URL(url).origin, `the picture on ${url} must load from that page's own host`);
      assert.equal(shown.width, 1, `the picture on ${url} must render`);
    }
    console.error("  ✓ limb 8 — a picture uploaded on a tenant's host rendered from each page's own host");
    await context.close();
  } finally {
    await vite.close();
    await browser.close();
  }
}
