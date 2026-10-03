/**
 * **Signed out, every door leads to the platform host's login — and nothing else renders first.**
 *
 * Studio carries no login and no signed-out stage of its own. A signed-out visit to a scope host
 * goes to the platform host's login when its first refresh answers 401, naming itself in
 * `return_to`; the apex redirects to the platform host, whose Home finds no session and goes to the
 * same login. The rail and composer never render for a visit that has no session.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **The apex, signed out, reaches the login form.** The apex redirects to the platform host,
 *     whose Home finds no session and leaves for `/auth/login`. *Reds if the apex serves a page of
 *     its own, or Home renders empty rather than sending the visitor to log in.*
 *  2. **A workspace host, signed out, reaches the login form with `return_to` naming it, and never
 *     shows the rail.** *Reds if Studio's 401 handling stops sending the page to log in, or the
 *     rail renders before there is a session.*
 *  3. **Each page costs EXACTLY its one session probe**, each answered 401 and logged by the browser
 *     as a console error: Home's summary on the platform host; the refresh from the workspace's
 *     host; and the login's own read of Home's summary, which a `return_to` naming a scope's host
 *     triggers so a pending membership there is offered its consent. The probes are how an
 *     HttpOnly cookie's absence is learned at all. *Reds against any other failed request or
 *     console error, and against a probe going missing, which would mean a returning person's
 *     session — or their pending consent — is no longer found on arrival.*
 *
 * Retired with the landing it drove: "Sign in is the front door", whose button lived on the
 * signed-out stage that no visit reaches any more.
 *
 * `needsContainer = false` — the shell only, never a build.
 */
import assert from 'node:assert/strict';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';
import { sharedApp } from '../lib/shared-app';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;
    const rail = () => page.getByRole('heading', { name: 'Lumenize Studio' });
    const composer = () => page.getByPlaceholder('Describe a change…');
    const onLogin = (u: URL) => u.origin === vite.viteBaseUrl && u.pathname === '/auth/login';

    // ── LIMB 1: the apex reaches the login form ────────────────────────────────────────────────
    const apex = vite.viteBaseUrl.replace('//platform.', '//');
    await page.goto(`${apex}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(onLogin, { timeout: 20_000 });
    await page.getByPlaceholder('you@example.com').waitFor({ state: 'visible', timeout: 20_000 });
    const capture = await captureArtifacts(inst, 'studio-signed-out-landing');
    console.error(`  ✓ limb 1 — the apex, signed out, reached the platform host's login (${capture.screenshotPath})`);

    // ── LIMB 2: a workspace host reaches the login form, with return_to naming it ──────────────
    // The run's shared app, to this signed-out visitor a stranger's: a host on the deployed target
    // answers only for an app that exists, since its certificate comes with the app.
    const stranger = (await sharedApp(stack, readDevVar('TEST_TOKEN'))).galaxy;
    const workspace = `${vite.scopeUrl(stranger)}/`;
    await page.goto(workspace, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(onLogin, { timeout: 20_000 });
    assert.equal(new URL(page.url()).searchParams.get('return_to'), workspace,
      'the login must carry return_to naming the page that sent it');
    await page.getByPlaceholder('you@example.com').waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await rail().count(), 0, 'a workspace host must not summon the rail before a session');
    assert.equal(await composer().count(), 0, 'a workspace host signed out has no composer');
    console.error('  ✓ limb 2 — a workspace host, signed out, reached the login with return_to naming it');

    // ── LIMB 3: exactly the session probes, nothing else ───────────────────────────────────────
    await captureArtifacts(inst, 'studio-signed-out-landing-login');
    assert.deepEqual(
      inst.failedRequests,
      [
        { url: `${vite.viteBaseUrl}/auth/home-summary`, status: 401, method: 'POST' },
        { url: `${vite.viteBaseUrl}/auth/refresh-token`, status: 401, method: 'POST' },
        { url: `${vite.viteBaseUrl}/auth/home-summary`, status: 401, method: 'POST' },
      ],
      `expected exactly the three session probes' 401s, got ${JSON.stringify(inst.failedRequests)}`,
    );
    // The status text is the protocol's: HTTP/1.1 locally sends "Unauthorized", and a deployed
    // Worker answering over HTTP/2 sends none, so Chrome prints "401 ()".
    const line = /^Failed to load resource: the server responded with a status of 401 \((Unauthorized)?\)$/;
    assert.ok(inst.consoleErrors.length === 3 && inst.consoleErrors.every((l) => line.test(l)),
      `expected only the browser's line for each 401, got ${JSON.stringify(inst.consoleErrors)}`);
    console.error('  ✓ limb 3 — each page cost exactly its session probe');
  } finally {
    await vite.close();
    await browser.close();
  }
}
