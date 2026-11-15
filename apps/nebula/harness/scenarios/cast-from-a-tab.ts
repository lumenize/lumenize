/**
 * **The agent builds a cast and makes a persona's data through the tabs of whoever asked.**
 *
 * O owns the app, signed up through the rendered screens, with Studio open in a browser. P is a
 * collaborator at the chat floor, invited as a person is, with Studio open in a browser of their
 * own. The app is the scenario's, standing in for earlier turns: the scaffold's `nebula.ts`, a
 * `Deal` type, an `App.vue` that puts its client on `window`, and a `docs/personas.md` whose cast
 * is `gerry` and whose steps are in plain words.
 *
 * The model is the real one, and what code it writes for `run_in_tab` is its choice. So no limb
 * waits on its wording or reads its code. Each waits on what a run leaves behind: a membership the
 * Worker accepted by mail, a grant in the tree, a stored record. `run-in-tab.test.ts` gates whose
 * Studio is picked, a closed tab and the failures, with the model scripted; `persona-tabs` gates
 * the page's side with no model at all.
 *
 * Limbs, each isolated (`live-scenarios.md` — per limb):
 *
 *  1. **The cast is built from the asker's own tab.** O asks for the cast to be built as the file
 *     says. Gerry's tab comes to open as Gerry with O in `act`, and Gerry holds `write` on the
 *     node `deals`. Every `run_in_tab` call on the turn's message ran under O's claims, O's Studio
 *     heard its tabs answer, and P's Studio heard nothing. *Reds if the Galaxy asks a Studio of
 *     anyone but the person the turn works for.*
 *  2. **A persona's data is made in that persona's tab.** O asks for a deal as Gerry, one the file
 *     does not list, so no earlier turn can have made it. The stored
 *     record of the Deal names Gerry as its subject and O as the actor, and no agent. *Reds if
 *     Studio runs a persona's request in the "me" tab, where the record would name O.*
 *  3. **A collaborator's wipe goes through the agent, which builds the cast again in the same
 *     turn.** P asks for the test data to be wiped and says nothing of the cast. Limb 2's Deal is
 *     gone, `deals` is a new node Gerry holds `write` on, and the file's sample Deal is back,
 *     made in Gerry's tab with P as the actor. Every `run_in_tab` call ran under P's claims, and
 *     O's Studio heard nothing more. *Reds if the reset leaves the Star's rows.* That the agent
 *     builds the cast again unasked is the model following `define-the-cast`, gated here as
 *     limbs 1 and 2 gate what they ask for.
 *
 * `needsContainer = true` — the app is built in the build container.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/resources/client';
import { uniqueTestEmail, waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID, StudioClient } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { NodeInviteAck, Snapshot } from '@lumenize/resources';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { Frame, Page } from 'playwright';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import { askFrame } from '../lib/ask-frame';
import { refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = true;

const BUILD_TIMEOUT_MS = 240_000;
/** A real generation that runs code in tabs, and the mail an invite sends, fit well inside this. */
const TURN_TIMEOUT_MS = 300_000;
const COMPOSER = 'Describe a change…';
/** How long a persona's tab may take to open after its invite: the mail's round trip. */
const ACCEPT_BY_MAIL_MS = 90_000;

const APP_VUE = `<script setup lang="ts">
import { client } from './nebula';
(window as unknown as { __client?: unknown }).__client = client;
</script>

<template>
  <main class="p-4"><p data-testid="frame-label">cast-from-a-tab</p></main>
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

/** The Deal limb 2 asks for. The file's own sample data names another, which a turn may make at any time. */
const DEAL_TITLE = 'Initech pilot';
const PERSONAS_MD = `# Personas

## The cast

- \`gerry\` — Gerry Salesperson. Works his own deals.

## Building the cast

1. Create the node \`deals\` under the root.
2. Invite \`gerry\` onto \`deals\` with \`write\`.

## Sample data

1. As \`gerry\`, add a Deal titled "Acme renewal" at stage \`open\` under \`deals\`.
`;

/** Every `lumenize:ran` a Studio page hears from a frame it holds, kept on its window. */
const HEAR_RUNS = `window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'lumenize:ran') (window.__ran = window.__ran || []).push({ origin: e.origin, ok: e.data.ok === true });
});`;

type BuildReportLike = { bundle: { indexSha256?: string }; preview: { refreshed: boolean; why: string } };
type RunAnswer = { ok: boolean; value?: any; error?: string };
type Heard = { origin: string; ok: boolean };
type ToolCall = { name: string; args?: Record<string, unknown>; result?: { ok?: boolean }; error?: string; claims?: { sub?: string } };
type Value = { content?: string; replyTo?: string; codegen?: { toolCalls?: ToolCall[] } };
type FrameRead = { origin: string; sub?: string; actSub?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ms: number, check: () => Promise<boolean>): Promise<boolean> => {
  for (const deadline = Date.now() + ms; ;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
};

const frameTitle = (tab: string) => tab === 'me' ? 'Preview' : `Preview as ${tab}`;
async function tabFrame(page: Page, tab: string): Promise<Frame | undefined> {
  const handle = await page.locator(`iframe[title="${frameTitle(tab)}"]`).elementHandle().catch(() => null);
  return (await handle?.contentFrame()) ?? undefined;
}
/** What `tab`'s frame holds: its origin, and its client's subject and actor. */
async function readFrame(page: Page, tab: string): Promise<FrameRead | undefined> {
  const frame = await tabFrame(page, tab);
  return frame?.evaluate(() => {
    const c = (window as unknown as { __client?: { claims?: { sub?: string; act?: { sub?: string } } } }).__client;
    return { origin: location.origin, sub: c?.claims?.sub, actSub: c?.claims?.act?.sub };
  }).catch(() => undefined);
}
const heard = (page: Page) => page.evaluate('window.__ran || []') as Promise<Heard[]>;
/** Ask `tab`'s frame to run `code` from Studio's own page, to read what a turn left behind. */
async function askTab(page: Page, tab: string, code: string): Promise<RunAnswer> {
  const answer = await askFrame(page, frameTitle(tab), code);
  if (!answer) throw new Error(`Studio holds no frame titled "${frameTitle(tab)}", or it did not answer in 30 s`);
  return answer;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('cast');
  const galaxy = `${universe}.app`;
  const dev = `${galaxy}.dev`;

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const devUrl = new URL(vite.scopeUrl(dev));
  const personaHost = (slug: string) => devUrl.hostname.replace(/^dev\./, `${slug}--dev.`);
  const disposers: Array<() => void> = [];
  try {
    // ── O: the app, claimed through the rendered sign-up, built once with a cast in its file ──
    const o = await instrumentedPage(browser);
    await o.page.context().addInitScript({ content: HEAR_RUNS });
    await signUpInBrowser(o, vite.viteBaseUrl, { universe, appSlug: 'app', email: uniqueTestEmail(), nickname: 'Olive', testToken });
    await o.page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    const oCookie = (await o.page.context().cookies()).find((c) => c.name === `__Host-refresh-token.${universe}`);
    assert.ok(oCookie, "O's sign-up set no refresh cookie for the account");
    const oToken = await refreshAccessToken(stack.baseUrl, { refreshToken: oCookie.value, authScope: universe }, galaxy);
    // O's own client, for the source writes and the build. It opens no chat subscription, so the
    // Galaxy never takes it for a Studio tab of O's.
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
    await o.page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await until(60_000, async () => (await readFrame(o.page, 'me'))?.sub === oToken.sub), "O's me tab never showed the app as O");

    // ── P: a collaborator, invited as a person is, with Studio open in a browser of their own ──
    const pEmail = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, to: pEmail, timeout: 120_000 });
    let inviteLink: string;
    try {
      // Sent from a client on Studio's own page, as a person invites from Studio, so the link
      // names that page's origin and P's browser loads Studio from it.
      const studioPage = vite.scopeUrl(galaxy);
      const ctx = new Browser().context(studioPage);
      const inviter = new NebulaClient({
        baseUrl: studioPage, platformOrigin: vite.viteBaseUrl, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
        accessToken: oToken.accessToken, instanceName: `${oToken.sub}.${crypto.randomUUID().slice(0, 8)}`,
        fetch: ctx.fetch, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      });
      disposers.push(() => { try { inviter[Symbol.dispose](); } catch { /* already disposed */ } ctx.close(); });
      const ack = await inviter.lmz.callAsync('GALAXY', galaxy,
        inviter.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email: pEmail, tier: 'write' }]), { timeoutMs: 30_000 }) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      inviteLink = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    // A link at the Worker's own port would load Studio from a built copy, which a local stack
    // does not serve: Studio is vite's, from source.
    assert.ok(inviteLink.startsWith(vite.viteBaseUrl), `the invite links to ${new URL(inviteLink).origin}, Studio's page is ${vite.viteBaseUrl}`);
    const p = await instrumentedPage(browser);
    await p.page.context().addInitScript({ content: HEAR_RUNS });
    await p.page.goto(inviteLink, { waitUntil: 'domcontentloaded' });
    await p.page.getByTestId('consent-checkbox').check();
    await p.page.getByTestId('consent-nickname').fill('Pat');
    await p.page.getByTestId('consent-accept').click();
    const studioHost = new URL(vite.scopeUrl(galaxy)).hostname;
    await p.page.waitForURL((u) => u.hostname === studioHost, { timeout: 60_000 });
    await p.page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    // P's own client watches the thread, so the scenario reads each turn's message without
    // opening a chat subscription under O's name.
    const pCookie = (await p.page.context().cookies()).find((c) => c.name.startsWith('__Host-refresh-token.'));
    assert.ok(pCookie, "P's acceptance set no refresh cookie");
    const pToken = await refreshAccessToken(stack.baseUrl,
      { refreshToken: pCookie.value, authScope: pCookie.name.slice('__Host-refresh-token.'.length) }, galaxy);
    assert.notEqual(pToken.sub, oToken.sub);
    const watcher: Driver<StudioClient> = await connectDriver(stack, { scope: galaxy, session: pToken, Client: StudioClient });
    disposers.push(() => watcher.dispose());
    const thread = watcher.client.resources.subscribeQuery({ typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } });
    disposers.push(() => thread[Symbol.dispose]());
    await thread.ready;
    const messages = async (): Promise<Array<{ id: string; snap: Snapshot }>> => {
      const out: Array<{ id: string; snap: Snapshot }> = [];
      for (const id of thread.resourceIds) {
        const snap = await watcher.client.resources.read('Message', id) as Snapshot | null;
        if (snap) out.push({ id, snap });
      }
      return out;
    };
    /** O, or `as`, posts `text` from Studio's composer, and the agent's message replying to it comes back. */
    const ask = async (text: string, as: { page: Page; sub: string } = { page: o.page, sub: oToken.sub }): Promise<Value> => {
      const composer = as.page.getByPlaceholder(COMPOSER);
      await composer.fill(text);
      await composer.press('Enter');
      let reply: Value | undefined;
      const landed = await until(TURN_TIMEOUT_MS, async () => {
        const all = await messages();
        const post = all.find(({ snap }) => snap.meta.recordedClaims.sub === as.sub && (snap.value as Value).content === text);
        reply = post && all.find(({ snap }) => snap.meta.recordedClaims.sub === NEBULA_SUB && (snap.value as Value).replyTo === post.id)?.snap.value as Value | undefined;
        return reply !== undefined;
      });
      assert.ok(landed, `the agent never answered "${text.slice(0, 40)}…"`);
      return reply!;
    };
    const runsOf = (reply: Value) => (reply.codegen?.toolCalls ?? []).filter((tc) => tc.name === 'run_in_tab');
    const describe = (reply: Value) => JSON.stringify((reply.codegen?.toolCalls ?? []).map((tc) => [tc.name, tc.args?.tab, tc.result?.ok, tc.error?.slice(0, 160)]));
    /** Recorded, never gated: what the model ran in each tab and what came back. */
    const record = (turn: string, reply: Value): void => {
      console.error(`  · ${turn} said: ${(reply.content ?? '').slice(0, 300)}`);
      for (const tc of reply.codegen?.toolCalls ?? []) {
        if (tc.name !== 'run_in_tab') { console.error(`  · ${turn} ${tc.name} ${JSON.stringify(tc.args?.path ?? '')}${tc.error ? ` ERROR ${tc.error.slice(0, 200)}` : ''}`); continue; }
        console.error(`  · ${turn} run_in_tab ${String(tc.args?.tab)}: ${String(tc.args?.code).replace(/\s+/g, ' ').slice(0, 500)}`);
        console.error(`      → ${(tc.error ? `TOOL ERROR ${tc.error}` : JSON.stringify(tc.result)).slice(0, 400)}`);
      }
    };

    // ── LIMB 1: the cast is built from the asker's own tab ───────────────────────────────────
    const built = await ask('Build the cast as docs/personas.md says. The app is already built, so change no code.');
    const builtRuns = runsOf(built);
    record('turn 1', built);
    assert.ok(builtRuns.some((tc) => tc.result?.ok === true), `the turn ran no code in a tab that returned: ${describe(built)}`);
    assert.ok(builtRuns.every((tc) => tc.claims?.sub === oToken.sub), "every run_in_tab call must run under O's claims, whose post the turn took up");
    const oHeard = await heard(o.page);
    assert.ok(oHeard.length >= builtRuns.filter((tc) => tc.result !== undefined).length,
      `O's Studio must have heard a tab answer each run that returned: heard ${oHeard.length}`);
    assert.ok(oHeard.some((h) => new URL(h.origin).hostname === devUrl.hostname), "O's own page on the dev Star must have answered a run");
    assert.deepEqual(await heard(p.page), [], "P's Studio must have been asked to run nothing");
    // Gerry's tab opens once the Worker has accepted his invite's mail.
    await o.page.getByTestId('tab-gerry').click();
    let gerry: FrameRead | undefined;
    const opened = await until(ACCEPT_BY_MAIL_MS, async () => {
      gerry = await readFrame(o.page, 'gerry');
      if (gerry?.sub !== undefined) return true;
      await o.page.getByTitle('Reload preview').click().catch(() => { /* the button is busy */ });
      await sleep(2_000);
      return false;
    });
    assert.ok(opened, `Gerry's tab never opened, so the turn's code did not invite him at the address his host spells (${JSON.stringify(gerry)})`);
    assert.equal(new URL(gerry!.origin).hostname, personaHost('gerry'));
    assert.notEqual(gerry!.sub, oToken.sub, "Gerry's tab must not hold its opener's token");
    assert.equal(gerry!.actSub, oToken.sub, 'the opener rides in act');
    await o.page.getByTestId('tab-me').click();
    const tree = await askTab(o.page, 'me', `
      const t = store.lmz.orgTree.value;
      const deals = [...t.nodes].find(([, n]) => n.slug === 'deals');
      return { deals: deals && deals[0], tier: deals && t.permissions.get(deals[0]) && t.permissions.get(deals[0]).get(${JSON.stringify(gerry!.sub)}) };
    `);
    assert.equal(tree.ok, true, `O's page could not read the tree: ${tree.error}`);
    assert.ok(tree.value.deals, 'the turn must have created the node `deals`');
    assert.equal(tree.value.tier, 'write', 'Gerry must hold `write` on `deals`, as the file says');
    console.error("  ✓ limb 1 — the turn built the cast from O's own tab: Gerry is a member with write on deals, and P's Studio was asked nothing");

    // ── LIMB 2: a persona's data is made in that persona's tab ────────────────────────────────
    const made = await ask(`As gerry, add a Deal titled "${DEAL_TITLE}" at stage lead under deals. Change no code.`);
    record('turn 2', made);
    assert.ok(runsOf(made).every((tc) => tc.claims?.sub === oToken.sub), "every run_in_tab call must run under O's claims");
    const found = await askTab(o.page, 'me', `
      const q = client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'lead' } });
      await q.ready;
      const out = [];
      for (const id of q.resourceIds) {
        const snap = await client.resources.read('Deal', id);
        out.push({ title: snap.value.title, recordedClaims: JSON.parse(JSON.stringify(snap.meta.recordedClaims)) });
      }
      q[Symbol.dispose]();
      return out;
    `);
    assert.equal(found.ok, true, `O's page could not read the Deals: ${found.error}`);
    const deal = (found.value as Array<{ title: string; recordedClaims: { sub: string; act?: { sub?: string; act?: unknown } } }>)
      .find((d) => d.title === DEAL_TITLE);
    assert.ok(deal, `the turn made no Deal titled "${DEAL_TITLE}" at stage lead: ${JSON.stringify(found.value)} after ${describe(made)}`);
    assert.equal(deal.recordedClaims.sub, gerry!.sub, "the Deal's record must name Gerry, in whose tab it was made");
    assert.equal(deal.recordedClaims.act?.sub, oToken.sub, "the Deal's record must name O, who opened Gerry's tab, as the actor");
    assert.equal(deal.recordedClaims.act?.act, undefined, 'no agent stands behind a write a tab made');
    assert.deepEqual(await heard(p.page), [], "P's Studio must still have been asked to run nothing");
    console.error("  ✓ limb 2 — the turn made Gerry's Deal in Gerry's tab: its record names Gerry, with O as actor and no agent");

    // ── LIMB 3: a collaborator's wipe goes through the agent, which builds the cast again ─────
    const oHeardBefore = (await heard(o.page)).length;
    const pOnDev = await readFrame(p.page, 'me');
    assert.ok(pOnDev?.sub, "P's me tab never showed the app as P");
    const wiped = await ask('Wipe the test data. Change no code.', { page: p.page, sub: pToken.sub });
    record('turn 3', wiped);
    assert.ok(runsOf(wiped).length > 0 && runsOf(wiped).every((tc) => tc.claims?.sub === pToken.sub),
      `every run_in_tab call must run under P's claims, whose post the turn took up: ${describe(wiped)}`);
    assert.equal((await heard(o.page)).length, oHeardBefore, "O's Studio must have been asked to run nothing for P's turn");
    type After = { deals?: string; tier?: string; titles: Array<{ title: string; sub: string; actSub?: string }> };
    let after: After | undefined;
    const rebuilt = await until(ACCEPT_BY_MAIL_MS, async () => {
      const read = await askTab(p.page, 'me', `
        const t = store.lmz.orgTree.value;
        const deals = [...t.nodes].find(([, n]) => n.slug === 'deals');
        const q = client.resources.subscribeQuery({ typeName: 'Deal', filter: {}, allowScan: true });
        await q.ready;
        const titles = [];
        for (const id of q.resourceIds) {
          const snap = await client.resources.read('Deal', id);
          if (snap) titles.push({ title: snap.value.title, sub: snap.meta.recordedClaims.sub, actSub: snap.meta.recordedClaims.act && snap.meta.recordedClaims.act.sub });
        }
        q[Symbol.dispose]();
        return { deals: deals && deals[0], tier: deals && t.permissions.get(deals[0]) && t.permissions.get(deals[0]).get(${JSON.stringify(gerry!.sub)}), titles };
      `);
      after = read.ok ? read.value as After : undefined;
      return after?.tier === 'write' && after.titles.some((d) => d.title === 'Acme renewal');
    });
    assert.ok(after, "P's page could not read the tree and the Deals after the wipe");
    assert.equal(after.titles.some((d) => d.title === DEAL_TITLE), false, `limb 2's Deal must be gone after the wipe: ${JSON.stringify(after.titles)}`);
    assert.ok(rebuilt, `the turn must have built the cast again: ${JSON.stringify(after)} after ${describe(wiped)}`);
    assert.notEqual(after.deals, tree.value.deals, 'the node `deals` must be a new one, since the wipe dropped the first');
    const sample = after.titles.find((d) => d.title === 'Acme renewal')!;
    assert.deepEqual([sample.sub, sample.actSub], [gerry!.sub, pOnDev.sub], "the file's sample Deal must be made in Gerry's tab, with P as the actor");
    console.error("  ✓ limb 3 — P's turn wiped the Star and built the cast again: limb 2's Deal is gone, Gerry holds write on a new deals node, and the sample Deal names Gerry with P as actor");
  } finally {
    for (const d of disposers.reverse()) { try { d(); } catch { /* already released */ } }
    await browser.close();
    await vite.close();
  }
}
