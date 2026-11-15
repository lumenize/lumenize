/**
 * **Studio shows the cast as tabs, and each persona's tab is that member's own page.**
 *
 * O owns the app, signed up through the rendered screens, so O's browser holds the session every
 * persona's tab is opened from. The app is the scenario's: the scaffold's `nebula.ts`, a `Deal`
 * type with an index on its stage, and an `App.vue` that puts its client on `window` so a limb can
 * read a frame's token. `docs/personas.md` names a cast of `gerry`, `sally` and `manny`.
 *
 * No model runs. Where the agent's `run_in_tab` would have Studio ask a tab to run code, a limb
 * posts the same message from Studio's own page, `{ type: 'lumenize:run', id, code }` to the tab's
 * frame, and reads the page's answer. So what is driven is the page's side and everything the code
 * reaches; how a turn gets the request to Studio is `cast-from-a-tab`'s.
 *
 * Limbs, each isolated (`live-scenarios.md` — per limb):
 *
 *  1. **The strip is the file's cast.** Studio shows `me` and then each persona, and a persona nobody
 *     has invited says so where its page would be. *Reds if the cast is read from anywhere but
 *     `docs/personas.md`.*
 *  2. **The "me" tab builds the cast.** Asked to run code, O's own page spells each persona's
 *     address, creates a node, and invites Gerry with `write` and Sally with `read` on it. The
 *     addresses are the ones the hosts spell. *Reds if the page cannot spell an address.*
 *  3. **Gerry's tab opens as Gerry.** With nobody clicking a link, his frame comes to hold a token
 *     whose subject is not O and whose `act` is O, on his own host. *Reds if a persona's frame is
 *     pointed at the dev Star's own host, or its token is its opener's.*
 *  4. **Gerry's own tab names him and writes as him.** Asked to run code, it sets his Profile's
 *     name and creates two Deals. The stored record of a Deal names Gerry as its subject and O as
 *     the actor, and no agent. *Reds if the record drops the actor, or names the opener as subject.*
 *  5. **Sally finds what Gerry made.** Her tab's query for open Deals holds Gerry's open Deal and
 *     not his lead. *Reds if a persona's page cannot query, or the filter is ignored.*
 *  6. **The URL is the strip.** With `sally` in view and `gerry` closed, reloading Studio restores
 *     both, and the URL holds slugs and no token (ADR-017). Sally's reloaded tab holds the org
 *     tree. *Reds if the strip forgets the URL, or if a reloaded page waits on its host's word to
 *     ask for its tree.*
 *  7. **A persona's page logs out by disconnecting.** On Gerry's own host, opened as a page of its
 *     own in O's browser, page script calls `client.logout()`: the client disconnects, the URL
 *     does not change, and O's session still mints. *Reds if the logout goes through `/auth/logout`.*
 *  8. **A persona can administer the workspace.** From the "me" tab, `client.invite` with the admin
 *     bit makes Manny an admin member, and his tab's token carries the bit, where Sally's does not.
 *     *Reds if a persona's token takes its admin bit from anywhere but that persona's membership.*
 *
 * `needsContainer = true` — the app is built in the build container.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import { StudioClient } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import { personaAddress } from '@lumenize/mesh/client';
import { ROOT_NODE_ID } from '@lumenize/resources/client';
import type { Frame, Page } from 'playwright';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import { refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = true;

const BUILD_TIMEOUT_MS = 240_000;
const COMPOSER = 'Describe a change…';
/** How long a persona's tab may take to open after its invite: the mail's round trip. */
const ACCEPT_BY_MAIL_MS = 90_000;

/** The app: the scaffold's client, put on `window` so a limb can read a frame's token. */
const APP_VUE = `<script setup lang="ts">
import { client } from './nebula';
(window as unknown as { __client?: unknown }).__client = client;
</script>

<template>
  <main class="p-4"><p data-testid="frame-label">persona-tabs</p></main>
</template>
`;

const DEAL = `
/** @title Deal */
export interface Deal {
  /** @title Title */
  title: string;
  /**
   * @title Stage
   * @index
   */
  stage: 'lead' | 'open' | 'won';
}
`;

const PERSONAS_MD = `# Personas

## The cast

- \`gerry\` — Gerry Salesperson. Works his own deals.
- \`sally\` — Sally Salesperson. Sees the team's deals.
- \`manny\` — Manny Manager. Administers the workspace.

## Building the cast

From the me tab, invite each persona onto the deals node. Gerry gets write and Sally read.
`;

type BuildReportLike = { bundle: { indexSha256?: string }; preview: { refreshed: boolean; why: string } };
type RunAnswer = { ok: boolean; value?: any; error?: string; noSession?: boolean };
type FrameRead = { origin: string; sub?: string; actSub?: string; state?: string; admin?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ms: number, check: () => Promise<boolean>): Promise<boolean> => {
  for (const deadline = Date.now() + ms; ;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
};

const frameTitle = (tab: string) => tab === 'me' ? 'Preview' : `Preview as ${tab}`;
async function tabFrame(page: Page, tab: string): Promise<Frame | undefined> {
  const handle = await page.locator(`iframe[title="${frameTitle(tab)}"]`).elementHandle().catch(() => null);
  return (await handle?.contentFrame()) ?? undefined;
}
/** What `tab`'s frame holds: its origin, and its client's subject, actor and connection. */
async function readFrame(page: Page, tab: string): Promise<FrameRead | undefined> {
  const frame = await tabFrame(page, tab);
  return frame?.evaluate(() => {
    const c = (window as unknown as { __client?: { claims?: { sub?: string; act?: { sub?: string }; access?: { scopeAdmin?: boolean } }; connectionState?: string } }).__client;
    return { origin: location.origin, sub: c?.claims?.sub, actSub: c?.claims?.act?.sub, state: c?.connectionState, admin: c?.claims?.access?.scopeAdmin };
  }).catch(() => undefined);
}
/** The slugs the strip shows as tabs, `me` first. */
async function stripTabs(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="tab-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(4)));
}
/**
 * Ask `tab`'s frame to run `code`, as Studio does for the agent's `run_in_tab`: the same message,
 * from Studio's own page to the frame it holds, and the page's answer read back.
 */
async function askTab(page: Page, tab: string, code: string): Promise<RunAnswer> {
  // The page's side is a string, since a function tsx compiles gains a helper the page lacks.
  return page.evaluate(`new Promise((resolve, reject) => {
    const title = ${JSON.stringify(frameTitle(tab))};
    const frame = document.querySelector('iframe[title="' + title + '"]');
    if (!frame || !frame.contentWindow) { reject(new Error('Studio holds no frame titled "' + title + '"')); return; }
    const origin = new URL(frame.src).origin;
    const id = crypto.randomUUID().slice(0, 8);
    let timer;
    function on(e) {
      if (e.source !== frame.contentWindow || e.origin !== origin || !e.data || e.data.type !== 'lumenize:ran' || e.data.id !== id) return;
      clearTimeout(timer);
      removeEventListener('message', on);
      resolve(e.data);
    }
    timer = setTimeout(() => { removeEventListener('message', on); reject(new Error('the frame "' + title + '" did not answer in 30 s')); }, 30000);
    addEventListener('message', on);
    frame.contentWindow.postMessage({ type: 'lumenize:run', id, code: ${JSON.stringify(code)} }, origin);
  })`) as Promise<RunAnswer>;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('tabs');
  const galaxy = `${universe}.app`;
  const dev = `${galaxy}.dev`;

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const devUrl = new URL(vite.scopeUrl(dev));
  const personaHost = (slug: string) => devUrl.hostname.replace(/^dev\./, `${slug}--dev.`);
  const disposers: Array<() => void> = [];
  try {
    // ── O: the app, claimed through the rendered sign-up, with a client and a cast ───────────
    const o = await instrumentedPage(browser);
    await signUpInBrowser(o, vite.viteBaseUrl, { universe, appSlug: 'app', email: uniqueTestEmail(), nickname: 'Olive', testToken });
    await o.page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    const cookie = (await o.page.context().cookies()).find((c) => c.name === `__Host-refresh-token.${universe}`);
    assert.ok(cookie, "O's sign-up set no refresh cookie for the account");
    const oSession = { refreshToken: cookie.value, authScope: universe };
    const oToken = await refreshAccessToken(stack.baseUrl, oSession, galaxy);
    const driver: Driver = await connectDriver(stack, { scope: galaxy, session: oToken, Client: StudioClient });
    disposers.push(() => driver.dispose());
    const galaxyCall = <T>(chain: unknown, timeoutMs = 30_000): Promise<T> =>
      driver.client.lmz.callAsync('GALAXY', galaxy, chain as any, { timeoutMs }) as Promise<T>;
    const seed = await galaxyCall<string>(driver.client.ctn<Galaxy>().readSource('src/ontology.d.ts'));
    await galaxyCall(driver.client.ctn<Galaxy>().writeSource('src/ontology.d.ts', seed + DEAL));
    await galaxyCall(driver.client.ctn<Galaxy>().writeSource('src/App.vue', APP_VUE));
    await galaxyCall(driver.client.ctn<Galaxy>().writeSource('docs/personas.md', PERSONAS_MD));
    const report = await galaxyCall<BuildReportLike>(driver.client.ctn<Galaxy>().buildNow({}), BUILD_TIMEOUT_MS);
    assert.ok(report.preview.refreshed && report.bundle.indexSha256, `the build should land: ${report.preview.why}`);

    // ── LIMB 1: the strip is the file's cast ──────────────────────────────────────────────────
    await o.page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(30_000, async () => (await stripTabs(o.page)).join(',') === 'me,gerry,sally,manny'),
      `O's strip never showed the file's cast: ${(await stripTabs(o.page)).join(',')}`);
    assert.ok(await until(60_000, async () => (await readFrame(o.page, 'me'))?.sub !== undefined), "the me frame never showed the app's client");
    await o.page.getByTestId('tab-sally').click();
    await o.page.getByTestId('preview-notice').waitFor({ state: 'visible', timeout: 30_000 });
    assert.match(await o.page.getByTestId('preview-notice').innerText(), /^sally is not a member of the workspace yet/,
      'a persona nobody has invited must say so where its page would be');
    await o.page.getByTestId('tab-me').click();
    console.error('  ✓ limb 1 — the strip showed me and the cast docs/personas.md names, and uninvited Sally said so');

    // ── LIMB 2: the me tab builds the cast ────────────────────────────────────────────────────
    const built = await askTab(o.page, 'me', `
      const node = crypto.randomUUID();
      await client.orgTree.createNode(node, ${JSON.stringify(ROOT_NODE_ID)}, 'deals', 'Deals');
      const gerry = await client.personaAddress('gerry');
      const sally = await client.personaAddress('sally');
      const ack = await client.resources.invite(node, [{ email: gerry, tier: 'write' }, { email: sally, tier: 'read' }]);
      return { node, gerry, sally, ack, me: client.claims.sub };
    `);
    assert.equal(built.ok, true, `the me tab could not build the cast: ${built.error}`);
    assert.equal(built.value.me, oToken.sub, 'the me tab runs as the person whose Studio it is');
    assert.equal(built.value.gerry, await personaAddress({ persona: 'gerry', scope: dev }, stack.personaMailDomain),
      "the page must spell Gerry's address as his host does");
    assert.equal(built.value.sally, await personaAddress({ persona: 'sally', scope: dev }, stack.personaMailDomain));
    assert.deepEqual(built.value.ack, { accepted: 2, errors: [] }, `the invites: ${JSON.stringify(built.value.ack)}`);
    const dealsNode: string = built.value.node;
    console.error("  ✓ limb 2 — asked to run code, O's own page spelled both addresses and invited Gerry and Sally onto a node");

    // ── LIMB 3: Gerry's tab opens as Gerry ───────────────────────────────────────────────────
    /** Bring `tab` into view and reload it until its page holds a token, which waits on its mail. */
    const opened = async (tab: string): Promise<FrameRead> => {
      await o.page.getByTestId(`tab-${tab}`).click();
      let seen: FrameRead | undefined;
      const ok = await until(ACCEPT_BY_MAIL_MS, async () => {
        seen = await readFrame(o.page, tab);
        if (seen?.sub !== undefined) return true;
        await o.page.getByTitle('Reload preview').click().catch(() => { /* the button is busy */ });
        await sleep(2_000);
        return false;
      });
      assert.ok(ok, `${tab}'s tab never opened: its invite was not accepted in ${ACCEPT_BY_MAIL_MS / 1000} s (${JSON.stringify(seen)})`);
      return seen!;
    };
    const gerryFrame = await opened('gerry');
    assert.equal(new URL(gerryFrame.origin).hostname, personaHost('gerry'), "Gerry's frame must be on his own host");
    assert.notEqual(gerryFrame.sub, oToken.sub, "Gerry's frame's token must not be its opener's");
    assert.equal(gerryFrame.actSub, oToken.sub, 'the opener rides in act');
    // The frame's refresh also opened Gerry a session: the browser took the cookie its answer set,
    // from a fetch a framed page on another host made, and holds it for the platform host alone.
    const gerryCookie = (await o.page.context().cookies()).find((c) => c.name === `__Host-refresh-token.${galaxy}.gerry--dev`);
    assert.ok(gerryCookie, "O's browser must hold Gerry's own session cookie once his tab has opened");
    assert.deepEqual([gerryCookie.httpOnly, gerryCookie.secure, gerryCookie.domain.startsWith('.')], [true, true, false],
      "Gerry's cookie is HttpOnly and Secure, and belongs to one host");
    console.error("  ✓ limb 3 — Gerry's tab opened on his own host, as Gerry, with O in act and nobody clicking a link, and O's browser holds his session");

    // ── LIMB 4: Gerry's own tab names him and writes as him ───────────────────────────────────
    const open = crypto.randomUUID();
    const lead = crypto.randomUUID();
    const wrote = await askTab(o.page, 'gerry', `
      await client.updateMyProfile({ nickname: 'gerry', name: 'Gerry Salesperson' });
      const outcome = await client.resources.transaction({
        ${JSON.stringify(open)}: { op: 'create', typeName: 'Deal', nodeId: ${JSON.stringify(dealsNode)}, value: { title: 'Acme renewal', stage: 'open' } },
        ${JSON.stringify(lead)}: { op: 'create', typeName: 'Deal', nodeId: ${JSON.stringify(dealsNode)}, value: { title: 'Initech', stage: 'lead' } },
      });
      const snapshot = await client.resources.read('Deal', ${JSON.stringify(open)});
      return { kind: outcome.kind, recordedClaims: JSON.parse(JSON.stringify(snapshot.meta.recordedClaims)), profileId: client.claims.profileId };
    `);
    assert.equal(wrote.ok, true, `Gerry's tab could not write: ${wrote.error}`);
    assert.equal(wrote.value.kind, 'committed', `Gerry's Deals did not commit: ${JSON.stringify(wrote.value)}`);
    assert.equal(wrote.value.recordedClaims.sub, gerryFrame.sub, "the Deal's record names Gerry as its subject");
    assert.equal(wrote.value.recordedClaims.act?.sub, oToken.sub, "the Deal's record names O as the actor");
    assert.equal(wrote.value.recordedClaims.act?.act, undefined, 'no agent stands behind a write a tab made');
    // O reads Gerry's public Profile by its id, as any signed-in page may (ADR-012).
    const profile = driver.client.subscribeProfile(wrote.value.profileId);
    try {
      assert.deepEqual((await profile.snapshot).value, { nickname: 'gerry', name: 'Gerry Salesperson' },
        "Gerry's Profile must hold the name his own tab set");
    } finally {
      profile[Symbol.dispose]();
    }
    console.error("  ✓ limb 4 — Gerry's tab set his Profile's name and wrote two Deals whose record names Gerry, with O as actor");

    // ── LIMB 5: Sally finds what Gerry made ──────────────────────────────────────────────────
    const sallyFrame = await opened('sally');
    assert.equal(new URL(sallyFrame.origin).hostname, personaHost('sally'), "Sally's frame must be on her own host");
    const found = await askTab(o.page, 'sally', `
      const q = client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'open' } });
      await q.ready;
      const ids = [...q.resourceIds];
      q[Symbol.dispose]();
      return ids;
    `);
    assert.equal(found.ok, true, `Sally's tab could not query: ${found.error}`);
    assert.deepEqual(found.value, [open], "Sally's query for open Deals must hold Gerry's open Deal, and not his lead");
    console.error("  ✓ limb 5 — Sally's tab found the open Deal Gerry made, by a filter");

    // ── LIMB 6: the URL is the strip ──────────────────────────────────────────────────────────
    await o.page.getByTestId('close-gerry').click();
    assert.ok(await until(5_000, async () => !(await stripTabs(o.page)).includes('gerry')), "closing Gerry's tab left it in the strip");
    const url = new URL(o.page.url());
    assert.equal(url.searchParams.get('tab'), 'sally', `the URL must name the tab in view: ${url.search}`);
    assert.equal(url.searchParams.get('closed'), 'gerry', `the URL must name the closed tab: ${url.search}`);
    assert.doesNotMatch(url.href, /eyJ|token/i, 'the URL must hold no token');
    await o.page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(30_000, async () => (await stripTabs(o.page)).join(',') === 'me,sally,manny'), `the reload lost the strip: ${(await stripTabs(o.page)).join(',')}`);
    assert.ok(await until(60_000, async () => (await readFrame(o.page, 'sally'))?.sub === sallyFrame.sub), "the reload did not restore Sally's tab in view");
    assert.ok(await o.page.locator('iframe[title="Preview as sally"]').isVisible(), "Sally's frame must be the one in view");
    // A reloaded page keeps its tab's id, so its host counts it as the same client back with
    // nothing lost. It must ask for the org tree all the same, since the new load holds none.
    const reloaded = await askTab(o.page, 'sally', `return [...store.lmz.orgTree.value.nodes].map(([, node]) => node.slug);`);
    assert.equal(reloaded.ok, true, `Sally's reloaded tab holds no org tree: ${reloaded.error}`);
    assert.ok((reloaded.value as string[]).includes('deals'), `Sally's reloaded tab's tree lacks the node: ${JSON.stringify(reloaded.value)}`);
    console.error('  ✓ limb 6 — the URL named the tab in view and the closed one, held no token, and a reload restored both, each tab with its tree');

    // ── LIMB 8: a persona who administers the workspace ──────────────────────────────────────
    // Run before limb 7, which ends with a page of Gerry's own; the numbers are the header's.
    // The reload left only Sally's frame loaded, so bring O's own back first.
    await o.page.getByTestId('tab-me').click();
    assert.ok(await until(60_000, async () => (await readFrame(o.page, 'me'))?.sub === oToken.sub), "O's me tab never came back after the reload");
    const admin = await askTab(o.page, 'me', `
      const summary = await client.invite(client.claims.aud, [{ email: await client.personaAddress('manny'), scopeAdmin: true }]);
      return { errors: summary.errors, outcomes: summary.results.map((r) => r.outcome) };
    `);
    assert.equal(admin.ok, true, `the me tab could not invite an admin persona: ${admin.error}`);
    assert.deepEqual(admin.value, { errors: [], outcomes: ['invited'] }, `the admin invite: ${JSON.stringify(admin.value)}`);
    const mannyFrame = await opened('manny');
    assert.equal(new URL(mannyFrame.origin).hostname, personaHost('manny'), "Manny's frame must be on his own host");
    assert.equal(mannyFrame.admin, true, "Manny's token must carry the admin bit his membership holds");
    assert.equal(mannyFrame.actSub, oToken.sub, 'the opener rides in act');
    // The plain member beside him, as the control: Sally's token carries no admin bit.
    const sallyNow = await readFrame(o.page, 'sally');
    assert.equal(sallyNow?.sub, sallyFrame.sub, "Sally's frame must still hold her token, or the control reads nothing");
    assert.notEqual(sallyNow?.admin, true, "Sally's token must carry no admin bit");
    console.error("  ✓ limb 8 — invited into the workspace with the admin bit from the me tab, Manny's tab opened as its admin");

    // ── LIMB 7: a persona's page logs out by disconnecting ───────────────────────────────────
    {
      const own = await o.page.context().newPage();
      const gerryUrl = `${devUrl.protocol}//${personaHost('gerry')}${devUrl.port ? `:${devUrl.port}` : ''}/`;
      await own.goto(gerryUrl, { waitUntil: 'domcontentloaded' });
      // Read inside the page: the client's state and claims are getters, which do not cross to Node.
      const state = () => own.evaluate(() => {
        const c = (window as unknown as { __client?: { connectionState?: string; claims?: { sub?: string } | null } }).__client;
        return { state: c?.connectionState, sub: c?.claims?.sub };
      }).catch(() => undefined);
      assert.ok(await until(60_000, async () => (await state())?.sub === gerryFrame.sub),
        `Gerry's own page never came up as Gerry: at ${own.url()}, holding ${JSON.stringify(await state())}`);
      await own.evaluate(() => (window as unknown as { __client: { logout(): Promise<void> } }).__client.logout());
      // The barrier: the client says it disconnected, so the logout has run to its end.
      assert.ok(await until(15_000, async () => (await state())?.state === 'disconnected'), "the logout never disconnected Gerry's page");
      assert.equal(own.url(), gerryUrl, "a persona page's logout must navigate nowhere");
      const still = await refreshAccessToken(stack.baseUrl, oSession, galaxy);
      assert.equal(still.sub, oToken.sub, "O's session must survive the persona page's logout");
      await own.close();
    }
    console.error("  ✓ limb 7 — Gerry's own page logged out by disconnecting, stayed where it was, and O's session still minted");
  } finally {
    for (const d of disposers.reverse()) { try { d(); } catch { /* already released */ } }
    await browser.close();
    await vite.close();
  }
}
