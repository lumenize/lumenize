/**
 * **A previewed build reaches every Studio on its app, and each preview reloads at its own URL.**
 *
 * Every landing records `.dev`'s newest `ServedBuild`; every Studio subscribed to
 * `ServedBuild where chat == DEFAULT_CHAT_ID` asks its frame to reload, naming the build; the frame
 * decides by the `buildVersion` in its own meta, and answers (ADR-024's build version).
 *
 * The cast: **O** owns the app; **P** is a collaborator at the chat floor, invited from Studio's
 * page as a person is. Each has Studio open in a browser context of their own. The app is the
 * scenario's, standing in for the model as `dev-tab-frame`'s does: a page that shows its path, so
 * a route like `/deals/42` survives a reload; a `nebula.ts` that records every `lumenize:reload`
 * the frame receives in its tab's `sessionStorage`; and, from limb 4, an `onShouldRefreshUI` that
 * shows a banner instead of reloading. A limb leaves a mark on the frame's `window`, which a
 * navigation clears, so every navigation is read from the frame itself, never from the iframe's
 * `src`.
 *
 * Limbs, each isolated (`live-scenarios.md` — per limb), in the order they run:
 *
 *  5b. **The Reload button navigates a preview with no client within 2 s**, before the app's
 *      first build, when `.dev` serves nothing. *Reds when the fallback waits 10 s.*
 *  1. **A landing reloads every preview at its URL.** Both frames sit at `/deals/42`; O's
 *     `buildNow` lands; both frames lose their mark, stay at `/deals/42`, and run the new build.
 *     *Reds when Studio skips the subscription, and when it sets the address instead of asking.*
 *  3. **A frame already current stays put.** P opens Studio fresh after a landing; the frame
 *     records a request naming the build it runs, and its mark survives 15 s. *Reds when the frame
 *     skips its comparison, and when Studio posts nothing on a first value.*
 *  2. **A landing Studio missed arrives when it comes back.** P's Studio is paused through CDP's
 *     `Debugger.pause`; O creates a `ServedBuild` naming the current build through the ordinary
 *     door, a write that starts no turn; its push goes unanswered past P's host node's 30 s wait,
 *     so the host closes P with 4408 and drops its subscriptions, which the reap marker shows; O
 *     lands build B; P resumes, subscribes again, and P's frame ends on B. Only the restored
 *     subscription can deliver B, since the landing's write reached no subscription of P's. No
 *     agent `Message` is committed while the limb runs. *Reds when Studio ignores the first value
 *     a restored subscription delivers; the no-turn check reds if the limb's write starts a turn.*
 *  4. **An app's banner keeps its choice.** After a landing the banner shows, and the frame keeps
 *     its mark and URL past Studio's 10 s wait. *Reds when Studio falls back on an echo naming the
 *     old build.*
 *  5. **The Reload button on a current frame** navigates it and keeps its URL, past the app's
 *     banner. *Reds when the button names the current build.*
 *  6. **A request from another window is ignored.** An `about:blank` frame at Studio's origin
 *     posts `lumenize:reload` to the dev tab, which neither reloads nor answers; the same request
 *     from Studio itself, the positive control, is obeyed. *Reds when the frame drops its
 *     `window.parent` check.*
 *
 * `needsContainer = true` — every build runs in the build container.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { uniqueTestEmail, waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { NebulaClient } from '@lumenize/resources/client';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID, StudioClient } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { NodeInviteAck } from '@lumenize/resources';
import type { Frame, Page } from 'playwright';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { debugLines, LOG_WAIT_MS, waitForDebugLines } from '../lib/stdio';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import { refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = true;
export const bootVars = { DEBUG: 'nebula.Resources.reap,nebula.Galaxy.landing' };

const BUILD_TIMEOUT_MS = 240_000;
const COMPOSER = 'Describe a change…';
const ROUTE = '/deals/42';
/** Where the app's `nebula.ts` keeps every `lumenize:reload` its frame received, per tab. */
const RECORD_KEY = 'scenario.reload-requests';
/** Where it counts the loads of the frame, per tab. */
const LOADS_KEY = 'scenario.loads';

/** The app's bootstrap: the scaffold's, recording each reload request, with a banner when asked. */
const nebulaTs = (banner: boolean) => `// The scaffold's bootstrap, recording every lumenize:reload this frame receives.
// @ts-expect-error — vendored at image build, as in the scaffold.
import { createNebulaClient } from '@lumenize/resources/frontend';

sessionStorage.setItem('${LOADS_KEY}', String(Number(sessionStorage.getItem('${LOADS_KEY}') ?? '0') + 1));
const seen: unknown[] = JSON.parse(sessionStorage.getItem('${RECORD_KEY}') ?? '[]');
window.addEventListener('message', (e) => {
  if ((e.data as { type?: string } | null)?.type !== 'lumenize:reload') return;
  seen.push(e.data);
  sessionStorage.setItem('${RECORD_KEY}', JSON.stringify(seen));
});

const content = document.querySelector('meta[name="nebula-scope"]')?.getAttribute('content') ?? '{}';
const { ontologyVersion } = JSON.parse(content) as { ontologyVersion?: string };

export const { client, store, ready } = createNebulaClient({
  ontologyVersion,${banner ? `
  onShouldRefreshUI: () => { (window as unknown as { __banner?: () => void }).__banner?.(); },` : ''}
});

await ready.catch(() => { /* the factory has already acted on it */ });
`;
/** The app: its path, a label that changes with each build, and the banner `nebula.ts` raises. */
const appVue = (label: string) => `<script setup lang="ts">
import { ref } from 'vue';
import { client } from './nebula';
void client;
const path = ref(location.pathname);
const banner = ref(false);
(window as unknown as { __banner?: () => void }).__banner = () => { banner.value = true; };
</script>

<template>
  <main class="p-4">
    <p data-testid="frame-path">{{ path }}</p>
    <p data-testid="frame-label">${label}</p>
    <p v-if="banner" data-testid="frame-banner">A new version is available</p>
  </main>
</template>
`;

type BuildReportLike = { bundle: { indexSha256?: string }; preview: { refreshed: boolean; why: string } };
type FrameState = { origin: string; path: string; marked: boolean; build?: string; banner: boolean; app: boolean; loads: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until `check` holds, polling; false when `ms` ran out. */
const until = async (ms: number, check: () => Promise<boolean>): Promise<boolean> => {
  for (const deadline = Date.now() + ms; ;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
};

/** Studio's frame of the dev tab, re-resolved each time: Studio replaces the element to navigate. */
async function previewFrame(page: Page): Promise<Frame | undefined> {
  const handle = await page.locator('iframe[title="Preview"]').elementHandle().catch(() => null);
  return (await handle?.contentFrame()) ?? undefined;
}
/** What the frame's document shows now, or `undefined` while it is between documents. */
async function frameState(page: Page): Promise<FrameState | undefined> {
  const frame = await previewFrame(page);
  return frame?.evaluate((loadsKey) => {
    const content = document.querySelector('meta[name="nebula-scope"]')?.getAttribute('content');
    return {
      origin: location.origin,
      loads: Number(sessionStorage.getItem(loadsKey) ?? '0'),
      path: location.pathname,
      marked: (window as unknown as { __mark?: boolean }).__mark === true,
      build: content ? (JSON.parse(content) as { buildVersion?: string }).buildVersion : undefined,
      banner: document.querySelector('[data-testid="frame-banner"]') !== null,
      app: document.querySelector('[data-testid="frame-path"]') !== null,
    };
  }, LOADS_KEY).catch(() => undefined);
}
/** Mark the frame's window, after moving it to `route` as the app's own router would. */
async function markFrame(page: Page, route?: string): Promise<boolean> {
  const frame = await previewFrame(page);
  return (await frame?.evaluate((r) => {
    if (r) history.pushState({}, '', r);
    (window as unknown as { __mark?: boolean }).__mark = true;
    return true;
  }, route).catch(() => false)) === true;
}
/** Every `lumenize:reload` the frame's tab recorded. */
async function frameRecord(page: Page): Promise<Array<{ id?: string; build?: string }>> {
  const frame = await previewFrame(page);
  return (await frame?.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]'), RECORD_KEY).catch(() => [])) ?? [];
}
/** Wait for the frame to show the app, running `build` when one is named. */
async function frameShows(page: Page, build?: string, ms = 60_000): Promise<FrameState | undefined> {
  let state: FrameState | undefined;
  await until(ms, async () => {
    state = await frameState(page);
    return state?.app === true && (build === undefined || state.build === build);
  });
  return state;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('reach');
  const galaxy = `${universe}.app`;
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(64)} ${detail}`);
  };

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const devOrigin = new URL(vite.scopeUrl(`${galaxy}.dev`)).origin;
  const disposers: Array<() => void> = [];
  try {
    // ── O: the app, claimed through the rendered sign-up ─────────────────────────────────────
    const oEmail = uniqueTestEmail();
    const o = await instrumentedPage(browser);
    await signUpInBrowser(o, vite.viteBaseUrl, { universe, appSlug: 'app', email: oEmail, nickname: 'Olive', testToken });
    await o.page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    const cookie = (await o.page.context().cookies()).find((c) => c.name === `__Host-refresh-token.${universe}`);
    assert.ok(cookie, "O's sign-up set no refresh cookie for the account");
    const oToken = await refreshAccessToken(stack.baseUrl, { refreshToken: cookie.value, authScope: universe }, galaxy);
    const driver: Driver = await connectDriver(stack, { scope: galaxy, session: oToken, Client: StudioClient });
    disposers.push(() => driver.dispose());
    const galaxyCall = <T>(chain: unknown, timeoutMs = 30_000): Promise<T> =>
      driver.client.lmz.callAsync('GALAXY', galaxy, chain as any, { timeoutMs }) as Promise<T>;
    const write = (path: string, content: string) => galaxyCall(driver.client.ctn<Galaxy>().writeSource(path, content));
    let builds = 0;
    /** Write a fresh label (and, when asked, the bootstrap) and land it; returns the build's digest. */
    const land = async (opts: { banner?: boolean } = {}): Promise<string> => {
      builds++;
      if (opts.banner !== undefined) await write('src/nebula.ts', nebulaTs(opts.banner));
      await write('src/App.vue', appVue(`build-${builds}`));
      const report = await galaxyCall<BuildReportLike>(driver.client.ctn<Galaxy>().buildNow({}), BUILD_TIMEOUT_MS);
      assert.ok(report.preview.refreshed && report.bundle.indexSha256, `build ${builds} should land: ${report.preview.why}`);
      return report.bundle.indexSha256!;
    };

    // ── LIMB 5b: before the first build, Reload navigates a preview with no client ───────────
    // Marked once the frame holds the dev host's own document, never the iframe's first
    // `about:blank`, which the first real load replaces whatever Studio does.
    assert.ok(await until(30_000, async () => (await frameState(o.page))?.origin === devOrigin),
      "O's preview frame never loaded the dev host's page");
    await sleep(3_000); // past the load's own settle window, so only the button can move it
    assert.ok(await markFrame(o.page), "O's preview frame could not be marked before the first build");
    const clicked = Date.now();
    await o.page.getByTitle('Reload preview').click();
    const moved = await until(8_000, async () => (await frameState(o.page))?.marked === false);
    const movedMs = Date.now() - clicked;
    record('limb 5b — Reload navigates a preview with no client within 2 s',
      moved && movedMs < 4_000, moved ? `navigated after ${movedMs} ms` : 'never navigated within 8 s');

    // ── The app's first build, and P ─────────────────────────────────────────────────────────
    const b1 = await land({ banner: false });
    assert.ok((await frameShows(o.page, b1))?.app, "O's preview never showed the first build");
    // P is invited the way a person is invited from Studio: from a client on Studio's own page.
    const pEmail = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, to: pEmail, timeout: 120_000 });
    let inviteLink: string;
    try {
      const studioPage = vite.scopeUrl(galaxy);
      const ctx = new Browser().context(studioPage);
      const inviter = new NebulaClient({
        baseUrl: studioPage, platformOrigin: vite.viteBaseUrl, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
        accessToken: oToken.accessToken, instanceName: `${oToken.sub}.${crypto.randomUUID().slice(0, 8)}`,
        fetch: ctx.fetch, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      });
      disposers.push(() => { try { inviter[Symbol.dispose](); } catch { /* already disposed */ } ctx.close(); });
      const ack = await inviter.lmz.callAsync('GALAXY', galaxy,
        inviter.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email: pEmail, tier: 'write' }]),
        { timeoutMs: 30_000 }) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      inviteLink = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    const p = await instrumentedPage(browser);
    await p.page.goto(inviteLink, { waitUntil: 'domcontentloaded' });
    await p.page.getByTestId('consent-checkbox').check();
    await p.page.getByTestId('consent-nickname').fill('Pat');
    await p.page.getByTestId('consent-accept').click();
    const studioHost = new URL(vite.scopeUrl(galaxy)).hostname;
    await p.page.waitForURL((u) => u.hostname === studioHost, { timeout: 60_000 });
    await p.page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    assert.ok((await frameShows(p.page, b1))?.app, "P's preview never showed the app");

    // ── LIMB 1: a landing reloads every preview at its URL ───────────────────────────────────
    assert.ok(await markFrame(o.page, ROUTE) && await markFrame(p.page, ROUTE), 'the frames could not be marked at the route');
    const b2 = await land();
    const at = async (page: Page) => (await until(45_000, async () => {
      const s = await frameState(page);
      return s?.app === true && s.build === b2 && !s.marked && s.path === ROUTE;
    })) ? 'reloaded at the route' : JSON.stringify(await frameState(page));
    const [o1, p1] = [await at(o.page), await at(p.page)];
    record('limb 1 — a landing reloads every preview at its URL',
      o1 === 'reloaded at the route' && p1 === 'reloaded at the route', `O's frame ${o1}; P's frame ${p1}`);

    // ── LIMB 3: a frame already current stays put ────────────────────────────────────────────
    const fresh = await p.page.context().newPage();
    await fresh.goto(`${vite.scopeUrl(galaxy)}/`, { waitUntil: 'domcontentloaded' });
    await fresh.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    const freshShown = await frameShows(fresh, b2);
    const freshMarked = freshShown?.app === true && await markFrame(fresh);
    const asked = await until(10_000, async () => (await frameRecord(fresh)).some((r) => r.build === b2));
    await sleep(15_000);
    const freshAfter = await frameState(fresh);
    // One load in this tab: a frame that reloaded on the request, even before the mark went on,
    // counts two.
    record('limb 3 — a frame already current records the request and stays put',
      freshMarked && asked && freshAfter?.marked === true && freshAfter.loads === 1,
      `${asked ? 'a request naming its own build arrived' : 'NO request naming its build arrived'}; ` +
      `mark ${freshAfter?.marked ? 'kept' : 'GONE'} after 15 s; ${freshAfter?.loads} load(s) in the tab`);
    await fresh.close();

    // ── LIMB 2: a landing Studio missed arrives when it comes back ───────────────────────────
    using thread = driver.client.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID });
    await thread.ready;
    const messagesBefore = thread.resourceIds.length;
    const isReap = (l: { namespace: string; message: string; data: Record<string, unknown> }) =>
      l.namespace === 'nebula.Resources.reap' && l.message === 'update not delivered' && l.data.name === 'ClientDisconnectedError';
    /** A write through the ordinary door, naming the build `.dev` already serves, so no Studio is
     *  asked to reload and no turn starts: only its push to each subscriber matters. */
    const forge = async () => {
      const forged = await driver.client.resources.transaction({
        [crypto.randomUUID()]: { op: 'create', typeName: 'ServedBuild', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, star: 'dev', buildVersion: b2 } },
      });
      assert.equal(forged.kind, 'committed', `the door write was ${forged.kind}`);
    };
    // First, while P is awake, a write whose push reaps limb 3's closed tab, so the only tab a
    // later reap can name is P's.
    const reapsAtStart = debugLines(stack.logs()).filter(isReap).length;
    await forge();
    await waitForDebugLines(stack, (all) => all.filter(isReap).length > reapsAtStart, "the closed tab's reap", 15_000)
      .catch(() => { /* its rows went with its socket */ });
    await sleep(2_000);
    const reapsBefore = debugLines(stack.logs()).filter(isReap).length;
    const cdp = await p.page.context().newCDPSession(p.page);
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.pause');
    await forge();
    const reaped = await waitForDebugLines(stack, (all) => all.filter(isReap).length > reapsBefore, "the paused Studio's reap",
      Math.max(45_000, LOG_WAIT_MS)).then(() => true, () => false);
    const b3 = await land();
    await cdp.send('Debugger.resume');
    await cdp.send('Debugger.disable');
    const pOnB3 = await until(60_000, async () => (await frameState(p.page))?.build === b3);
    await sleep(2_000); // an agent message the write had started would have landed by now
    const messagesAfter = thread.resourceIds.length;
    record('limb 2 — a landing Studio missed arrives when it comes back',
      reaped && pOnB3 && messagesAfter === messagesBefore,
      `${reaped ? 'P was reaped' : 'NO reap of the paused page'}; P's frame ${pOnB3 ? 'ended on the build it missed' : `is on ${(await frameState(p.page))?.build}`}; ` +
      `${messagesAfter - messagesBefore} messages committed meanwhile`);

    // ── LIMB 4: an app's banner keeps its choice ─────────────────────────────────────────────
    const b4 = await land({ banner: true });
    assert.ok((await frameShows(o.page, b4))?.app && (await frameShows(p.page, b4))?.app, 'the frames never reached the banner build');
    assert.ok(await markFrame(o.page, ROUTE) && await markFrame(p.page, ROUTE), 'the banner frames could not be marked');
    const b5 = await land();
    const bannered = await until(45_000, async () => (await frameState(o.page))?.banner === true && (await frameState(p.page))?.banner === true);
    await sleep(12_000); // past Studio's 10 s wait for an echo
    const [o4, p4] = [await frameState(o.page), await frameState(p.page)];
    const kept = (s?: FrameState) => s?.banner === true && s.marked && s.path === ROUTE && s.build === b4;
    record("limb 4 — an app's banner keeps its choice past Studio's wait",
      bannered && kept(o4) && kept(p4), `O's frame ${JSON.stringify(o4)}; P's frame ${JSON.stringify(p4)}`);

    // ── LIMB 5: the Reload button on a current frame navigates it at its URL ─────────────────
    await o.page.getByTitle('Reload preview').click();
    const reloaded = await until(30_000, async () => {
      const s = await frameState(o.page);
      return s?.app === true && !s.marked && s.path === ROUTE && s.build === b5;
    });
    record('limb 5 — the Reload button navigates a current frame and keeps its URL',
      reloaded, reloaded ? 'navigated, at the route, on the served build' : JSON.stringify(await frameState(o.page)));

    // ── LIMB 6: a request from another window is ignored ─────────────────────────────────────
    assert.ok(await markFrame(o.page, ROUTE), "O's frame could not be marked for limb 6");
    await o.page.evaluate(() => {
      const w = window as unknown as { __echoes?: string[] };
      w.__echoes = [];
      window.addEventListener('message', (e) => {
        const data = e.data as { type?: string; id?: string } | null;
        if (data?.type === 'lumenize:loaded' && data.id) w.__echoes!.push(data.id);
      });
      const blank = document.createElement('iframe');
      blank.name = 'intruder';
      document.body.appendChild(blank);
    });
    // Posted from inside the blank frame, so the message's source is that frame, not Studio.
    const intruder = o.page.frame({ name: 'intruder' });
    assert.ok(intruder, 'the about:blank frame never attached');
    await intruder.evaluate((origin) => {
      const preview = (parent.document.querySelector('iframe[title="Preview"]') as HTMLIFrameElement).contentWindow!;
      preview.postMessage({ type: 'lumenize:reload', id: 'intruder' }, origin);
    }, devOrigin);
    await sleep(3_000);
    const echoesAfterIntruder = await o.page.evaluate(() => (window as unknown as { __echoes?: string[] }).__echoes ?? []);
    const afterIntruder = await frameState(o.page);
    await o.page.evaluate((origin) => {
      (document.querySelector('iframe[title="Preview"]') as HTMLIFrameElement).contentWindow!
        .postMessage({ type: 'lumenize:reload', id: 'own' }, origin);
    }, devOrigin);
    const obeyed = await until(15_000, async () => (await frameState(o.page))?.marked === false);
    const echoes = await o.page.evaluate(() => (window as unknown as { __echoes?: string[] }).__echoes ?? []);
    record('limb 6 — a request from another window is ignored, and Studio\'s own is obeyed',
      !echoesAfterIntruder.includes('intruder') && afterIntruder?.marked === true && obeyed && echoes.includes('own'),
      `the intruder's request ${echoesAfterIntruder.includes('intruder') ? 'WAS answered' : 'went unanswered'}, ` +
      `mark ${afterIntruder?.marked ? 'kept' : 'GONE'}; Studio's own ${obeyed ? 'reloaded the frame' : 'did NOT reload it'}` +
      `${echoes.includes('own') ? ' and was answered' : ', unanswered'}`);

    const open = results.filter((r) => !r.ok);
    assert.equal(open.length, 0,
      `${open.length} of ${results.length} properties do not hold:\n` + open.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'));
  } finally {
    for (const d of disposers) { try { d(); } catch { /* already released */ } }
    await browser.close();
    await vite.close();
  }
}
