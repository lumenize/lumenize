/**
 * **The `.dev` Star runs the last build that landed, and nothing else reaches a Star (ADR-024).**
 *
 * One app, claimed through the rendered sign-up as a person claims one, so the scenario's builds,
 * rewrites and wipes touch no other scenario's `.dev` Star. The scenario writes `src/ontology.d.ts`
 * through the Galaxy's source entry and calls `buildNow`, so no model turn makes it flaky, and every
 * page reads its version from the `nebula-scope` meta the `.dev` page is served with.
 *
 * Limbs, each isolated (`live-scenarios.md` — per limb):
 *
 *  1. **The preview follows the build.** A build adds `dueDate?: string` to `Deal`, and a page
 *     loaded afterwards writes a `Deal` with a due date that commits, with no other step. Studio's
 *     own client, which connects at the Galaxy's host, also runs an op on `.dev` first, so a Galaxy
 *     that recognised the `.dev` Star by the chain's origin rather than its last hop reds here.
 *     Locally the Star's `facet cold load` names the `.dev` Star's own `bundleId`.
 *     *Reds when landing stores no row, when the `.dev` key is the Galaxy's, or when the predicate
 *     reads `callChain[0]`.*
 *  2. **A build whose ontology does not compile moves nothing.** It also changes a visible string
 *     in `App.vue`; the served page and its version stay as they were, and an op at the old version
 *     still runs. Then the types are fixed and a rebuild lands: the version moves and the string
 *     ships. *Reds when `job.ts` runs `vite build` after a failed compile.*
 *  3. **A tenant Star installs nothing a build compiled.** A tenant page pinned to the `.dev`
 *     page's version has its op end `ontology-stale`; locally, the tenant asks its Galaxy, is
 *     answered no row, and installs nothing. *Reds when the Galaxy answers every caller with the
 *     `.dev` row.*
 *  4. **Studio's Wipe button says what the Star answered.** A chat collaborator, who has no passage
 *     into `.dev` from Studio's page, clicks Wipe and is shown the refusal; the owner's click
 *     reports success. *Reds when the button logs success before the answer.*
 *  5. **A version change on `.dev` counts the rows its validator refuses.** On the wiped Star, five
 *     `Deal`s, two with a `stage`; a build adding an optional field counts 0 of 5, and a build
 *     retyping `stage` counts exactly 2 of 5 (locally, from the Star's log line). *Reds when the
 *     count covers every row or every type.*
 *  6. **A page current at the new version waits out the change without reloading.** A build adds
 *     `Pipeline`; the first page on the new version sends a list subscription while the Star still
 *     holds the old one, and two row subscriptions behind the gate its answer closes. It never
 *     calls `onShouldRefreshUI` and sees a `Deal` another client writes afterwards; locally the
 *     Star admits none of its subscribes before its `installed` line and never hears the held two
 *     until then. *Reds when the gate's opening sends nothing, or when a list subscription
 *     carries no version.*
 *  7. **A wipe drops the page's subscriptions, and the page takes them again.** The page holds
 *     two rows and two lists. Two wipes; after each, it calls no `onShouldRefreshUI` and both
 *     lists see `Deal`s written afterwards. The restore's first row is refused as missing once the
 *     Star installs, and the lists are refused behind the gate its answer closed. *Reds when a
 *     notice naming no version takes the reload path, when a probe refused for another reason
 *     keeps the gate closed, and when the gate's opening resends only first subscribes.*
 *  8. **A top-level page on the `.dev` host reloads once per build.** The app's own `nebula.ts`
 *     logs a console line from `onShouldRefreshUI` and reloads; the page is neither framed in
 *     Studio nor the build's requester. After each of two builds a second client sends one op, so
 *     the Star installs, and the page logs one line and reloads, once per build. *Reds with a
 *     guard that records that it reloaded rather than for which version.*
 *  9. **On a tenant Star the wait ends, and nothing keeps asking.** A transaction ends
 *     `ontology-stale` within the retry window, a read sent while it waited ends the same way, and
 *     locally the tenant logs no `ask` in the six seconds after both end. *Reds when the gate stays
 *     closed after the retries run out, or when a refusal naming no version restores.*
 *
 * `needsContainer = true` — every build runs in the build container.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { uniqueTestEmail, waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, StudioClient } from '@lumenize/nebula/client';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { NodeInviteAck } from '@lumenize/resources';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf, waitForHost } from '../lib/harness';
import { servedOntologyVersion } from '../lib/own-app';
import { clientIdIn, debugLines, waitForDebugLines } from '../lib/stdio';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import { foundTenantStar, refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = true;
export const bootVars = { DEBUG: 'nebula.Resources.ontology,nebula.Resources.source,nebula.Resources.subscribe,nebula.Galaxy.ontology' };

const BUILD_TIMEOUT_MS = 240_000;
const DEAL = `
/** @title Deal */
export interface Deal {
  /** @title Title */
  title: string;
}
`;
const DEAL_DUE = `
/** @title Deal */
export interface Deal {
  /** @title Title */
  title: string;
  /** @title Due date */
  dueDate?: string;
}
`;
const DEAL_STAGE = `
/** @title Deal */
export interface Deal {
  /** @title Title */
  title: string;
  /** @title Due date */
  dueDate?: string;
  /** @title Stage */
  stage?: string;
}
`;
const DEAL_OWNER = DEAL_STAGE.replace('  stage?: string;\n', '  stage?: string;\n  /** @title Owner */\n  owner?: string;\n');
const DEAL_STAGE_NUMBER = DEAL_OWNER.replace('  stage?: string;', '  stage?: number;');
const DEAL_PIPELINE = `${DEAL_OWNER.replace('  owner?: string;\n', '  owner?: string;\n  /** @title Pipeline */\n  pipeline?: Pipeline;\n')}
/** @title Pipeline */
export interface Pipeline {
  /** @title Name */
  name: string;
}
`;
const DEAL_PIPELINE_B = DEAL_PIPELINE.replace('  pipeline?: Pipeline;\n', '  pipeline?: Pipeline;\n  /** @title Probability */\n  probability?: number;\n');
const DEAL_PIPELINE_C = DEAL_PIPELINE_B.replace('  probability?: number;\n', '  probability?: number;\n  /** @title Region */\n  region?: string;\n');
/** Limb 8's console line, written by the app's own `onShouldRefreshUI` before it reloads. */
const RELOAD_LINE = 'limb-eight-reload';
const NEBULA_TS_LOGGING_RELOADS = `// The scaffold's bootstrap, with an onShouldRefreshUI that says when it reloads.
// @ts-expect-error — vendored at image build, as in the scaffold.
import { createNebulaClient } from '@lumenize/resources/frontend';

const content = document.querySelector('meta[name="nebula-scope"]')?.getAttribute('content') ?? '{}';
const { ontologyVersion } = JSON.parse(content) as { ontologyVersion?: string };

export const { client, store, ready } = createNebulaClient({
  ontologyVersion,
  onShouldRefreshUI: (info: { currentVersion: string }) => {
    console.log(\`${RELOAD_LINE} \${info.currentVersion}\`);
    location.reload();
  },
});

await ready.catch(() => { /* the factory has already acted on it */ });
`;
/** An app whose page holds a list subscription, so the built page runs a client. */
const appListing = (pipelineId: string) => `<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { client } from './nebula';

const deals = ref(-1);
onMounted(() => {
  const list = client.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Deal', field: 'pipeline', value: '${pipelineId}' });
  list.onChange(() => { deals.value = list.resourceIds.length; });
});
</script>

<template>
  <main class="p-8"><p data-testid="limb-eight-deals">{{ deals }}</p></main>
</template>
`;
const BROKEN = `\nexport interface Deal {\n  title: string\n`;
const MARK = 'limb-two-visible-string';
const APP_WITH_MARK = `<script setup lang="ts">
</script>

<template>
  <main class="p-8"><h1 class="text-2xl font-bold">${MARK}</h1></main>
</template>
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Whether `check` holds within `ms`, polled. */
const until = async (ms: number, check: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
};
/** `'ok'` when `p` settles in time, else what went wrong, so a limb reports rather than hangs. */
const within = async (ms: number, p: Promise<unknown>): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => 'ok', (e: Error) => `${e.name}: ${e.message}`.slice(0, 160)),
      new Promise<string>((r) => { timer = setTimeout(() => r(`no answer in ${ms / 1000} s`), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
/** How an op that should be refused for its version ended. */
const staleOrNot = (e: unknown) => (e as Error).name === 'OntologyStaleError' ? 'ontology-stale' : `${(e as Error).name}: ${(e as Error).message}`.slice(0, 160);

type BuildReportLike = {
  ontology: { ran: boolean; ok?: boolean; tail?: string };
  bundle: { ran: boolean; ok?: boolean; why?: string; tail?: string };
};

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('follow');
  const galaxy = `${universe}.app`;
  const dev = `${galaxy}.dev`;
  const tenant = `${galaxy}.tenant1`;
  const ownerEmail = uniqueTestEmail();
  const observable = stack.logs !== undefined;
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(64)} ${detail}`);
  };
  /** On a deployed target, say a log half is not observable; locally, record it. */
  const logHalf = async (name: string, check: () => Promise<[boolean, string]>) => {
    if (!observable) { console.log(`  · ${name} is not observable on a deployed target`); return; }
    const [ok, detail] = await check();
    record(name, ok, detail);
  };

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const disposers: Array<() => void> = [];
  // The pages' own Clients run in this process, so their gate lines are read here in either venue.
  const gateClosedFor = new Set<string>();
  setDebugSink((e) => {
    if (e.namespace === 'lumenize.nebula-client' && e.message === 'version gate closed') {
      gateClosedFor.add(String((e.data as { client?: unknown } | undefined)?.client));
    }
  });
  try {
    // ── The app: claimed through the rendered sign-up, so the owner's session is a browser's ──
    const owner = await instrumentedPage(browser);
    await signUpInBrowser(owner, vite.viteBaseUrl, {
      universe, appSlug: 'app', email: ownerEmail, nickname: 'Olive', testToken,
    });
    const cookie = (await owner.page.context().cookies()).find((c) => c.name === `__Host-refresh-token.${universe}`);
    assert.ok(cookie, "the owner's sign-up set no refresh cookie for the account");
    const session = { refreshToken: cookie.value, authScope: universe };
    const studioToken = await refreshAccessToken(stack.baseUrl, session, galaxy);
    // Studio's own client class, which hears the preview-ready push a build sends its requester.
    const studio: Driver = await connectDriver(stack, { scope: galaxy, session: studioToken, Client: StudioClient });
    disposers.push(() => studio.dispose());

    const galaxyCall = <T>(chain: unknown, timeoutMs = 30_000): Promise<T> =>
      studio.client.lmz.callAsync('GALAXY', galaxy, chain as any, { timeoutMs }) as Promise<T>;
    const write = (path: string, content: string) => galaxyCall(studio.client.ctn<Galaxy>().writeSource(path, content));
    const build = () => galaxyCall<BuildReportLike>(studio.client.ctn<Galaxy>().buildNow(), BUILD_TIMEOUT_MS);
    const servedHtml = async (): Promise<string> => (await fetch(`${scopeUrlOf(stack, dev)}/`)).text();
    const servedScript = async (html: string): Promise<string> => {
      const asset = /(assets\/[^"']+\.js)/.exec(html)?.[1];
      return asset ? (await fetch(`${scopeUrlOf(stack, dev)}/${asset}`)).text() : '';
    };

    /** A page on `scope`'s host pinned to `version`, as the app's own client is built against it.
     *  Each takes a fresh token from the session, as a page loaded now would: deployed, this run
     *  outlasts one access token. */
    const openPage = async (scope: string, version: string, onShouldRefreshUI?: () => void) => {
      await waitForHost(scopeUrlOf(stack, scope));
      const token = await refreshAccessToken(stack.baseUrl, session, scope);
      const ctx = new Browser().context(scopeUrlOf(stack, scope));
      const client = new NebulaClient({
        baseUrl: scopeUrlOf(stack, scope),
        platformOrigin: stack.baseUrl,
        ontologyVersion: version,
        resourceHostBinding: 'STAR',
        accessToken: token.accessToken,
        instanceName: `${token.sub}.${crypto.randomUUID().slice(0, 8)}`,
        fetch: ctx.fetch,
        sessionStorage: ctx.sessionStorage,
        BroadcastChannel: ctx.BroadcastChannel,
        onShouldRefreshUI,
      });
      disposers.push(() => { try { client[Symbol.dispose](); } catch { /* already disposed */ } ctx.close(); });
      // As a page's app waits on the factory's `ready` before any component subscribes; an op sent
      // sooner is sent again by the first connection's restore, which hides what the gate does.
      assert.ok(await until(30_000, () => client.connectionState === 'connected'), `a page on ${scope} never connected`);
      return client;
    };
    /** Every `Deal` a page created, in order, so a later limb can subscribe to rows that exist. */
    const createdDeals: string[] = [];
    /** Create one `Deal`, waiting out the Star's first-touch install; a final answer returns at once. */
    const createDeal = async (client: NebulaClient, value: Record<string, unknown>, waitMs = 30_000): Promise<string> => {
      const deadline = Date.now() + waitMs;
      const id = crypto.randomUUID();
      let last = '';
      while (Date.now() < deadline) {
        const outcome = await client.resources.transaction({ [id]: { op: 'create', typeName: 'Deal', nodeId: ROOT_NODE_ID, value } });
        last = outcome.kind;
        if (last === 'committed') createdDeals.push(id);
        if (last === 'committed' || last === 'rejected' || last === 'conflict') return last;
        await sleep(500);
      }
      return last;
    };

    // ── v1: the scaffold's ontology plus `Deal`, built ───────────────────────────────────────
    const seed = await galaxyCall<string>(studio.client.ctn<Galaxy>().readSource('src/ontology.d.ts'));
    await write('src/ontology.d.ts', seed + DEAL);
    const first = await build();
    assert.ok(first.ontology.ok && first.bundle.ok, `the first build should compile and bundle: ${JSON.stringify(first).slice(0, 600)}`);
    const v1 = await servedOntologyVersion(stack, dev);
    assert.ok(v1, 'the first build landed no version on the `.dev` page');

    // ── LIMB 1: the preview follows the build ────────────────────────────────────────────────
    await write('src/ontology.d.ts', seed + DEAL_DUE);
    await build();
    const v2 = await servedOntologyVersion(stack, dev);
    assert.ok(v2 && v2 !== v1, `adding dueDate did not land a new version (v1 ${v1}, now ${v2})`);
    // Studio's client first, so the `.dev` Star asks its Galaxy on a chain whose origin is a Client
    // at the Galaxy's host and whose last hop is the `.dev` Star.
    let studioAnswer = 'never answered';
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await studio.client.lmz.callAsync('STAR', dev, studio.client.ctn<Star>().resources.read(v2, crypto.randomUUID()));
        studioAnswer = 'ran';
        break;
      } catch (e) {
        studioAnswer = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 160);
        if (!((e as { checking?: boolean }).checking)) break;
        await sleep(500);
      }
    }
    const page = await openPage(dev, v2);
    const withDue = await createDeal(page, { title: 'Renewal', dueDate: '2026-11-01' });
    record('limb 1 — a page loaded after the build writes a Deal with a due date',
      studioAnswer === 'ran' && withDue === 'committed',
      `Studio's op on .dev ${studioAnswer}; the page's Deal with a due date was ${withDue}`);
    await logHalf("limb 1 — the .dev Star's validator is keyed on its own name", async () => {
      const lines = await waitForDebugLines(stack, (all) => all.some((l) =>
        l.namespace === 'nebula.Resources.ontology' && l.message === 'facet cold load' && l.data.version === v2),
      `a facet cold load for ${v2}`).catch(() => debugLines(stack.logs?.() ?? ''));
      const ids = lines.filter((l) => l.message === 'facet cold load' && l.data.version === v2).map((l) => l.data.bundleId);
      return [ids.length > 0 && ids.every((id) => id === `${dev}/${v2}`), `bundleIds for ${v2}: ${JSON.stringify(ids)}`];
    });

    // ── LIMB 2: a build whose ontology does not compile moves nothing ──────────────────────
    const htmlBefore = await servedHtml();
    await write('src/App.vue', APP_WITH_MARK);
    await write('src/ontology.d.ts', seed + BROKEN);
    const broken = await build();
    const htmlAfter = await servedHtml();
    const vAfterBroken = await servedOntologyVersion(stack, dev);
    const stillRuns = await createDeal(page, { title: 'still v2', dueDate: '2026-12-01' }, 5_000);
    record('limb 2 — a failed compile moves neither the page nor its types',
      broken.ontology.ok === false && broken.bundle.ran === false
        && htmlAfter === htmlBefore && vAfterBroken === v2 && stillRuns === 'committed',
      `compile ok=${broken.ontology.ok}, bundle ran=${broken.bundle.ran}; page ${htmlAfter === htmlBefore ? 'unchanged' : 'CHANGED'}; ` +
      `version ${vAfterBroken === v2 ? 'unchanged' : `moved to ${vAfterBroken}`}; an op at the old version ${stillRuns}`);
    // Positive control: the fixed types land, and the page that waited for them ships.
    await write('src/ontology.d.ts', seed + DEAL_STAGE);
    const fixed = await build();
    const v3 = await servedOntologyVersion(stack, dev);
    const shipped = (await servedScript(await servedHtml())).includes(MARK);
    record('limb 2 — the fixed build lands its types and its page together',
      fixed.ontology.ok === true && fixed.bundle.ok === true && v3 !== undefined && v3 !== v2 && shipped,
      `version ${v3 === v2 ? 'did not move' : `moved to ${v3}`}; the page ${shipped ? 'ships' : 'does NOT ship'} the new string`);

    // ── LIMB 3: a tenant Star installs nothing a build compiled ─────────────────────────────
    const founded = await foundTenantStar({ baseUrl: stack.baseUrl, star: tenant, testToken });
    assert.ok(founded, `${tenant} could not be founded`);
    const tenantPage = await openPage(tenant, v3!);
    const tenantOutcome = (await tenantPage.resources.transaction({
      [crypto.randomUUID()]: { op: 'create', typeName: 'Deal', nodeId: ROOT_NODE_ID, value: { title: 'never lands' } },
    })).kind;
    record('limb 3 — a tenant page pinned to the built version is answered ontology-stale',
      tenantOutcome === 'ontology-stale', `the tenant's op ended ${tenantOutcome}`);
    await logHalf('limb 3 — the tenant asked its Galaxy, got no row, and installed nothing', async () => {
      const lines = await waitForDebugLines(stack, (all) => all.some((l) =>
        l.message === 'ontology pull returned no row' && l.data.instanceName === tenant),
      `the tenant's empty answer`).catch(() => debugLines(stack.logs?.() ?? ''));
      const asked = lines.some((l) => l.namespace === 'nebula.Resources.source' && l.message === 'ask' && l.data.instanceName === tenant);
      const answered = lines.some((l) => l.message === 'ontology pull returned no row' && l.data.instanceName === tenant);
      const installed = lines.filter((l) => l.message === 'installed' && l.data.instanceName === tenant).length;
      return [asked && answered && installed === 0, `asked ${asked}, answered no row ${answered}, installs ${installed}`];
    });

    // ── LIMB 4: Studio's Wipe button says what the Star answered ────────────────────────────
    // The collaborator is invited the way a person is invited from Studio: from a client on
    // Studio's own page, so the link names the page a person would be on, and followed as sent.
    const austenEmail = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, to: austenEmail, timeout: 120_000 });
    let inviteLink: string;
    try {
      const studioPage = vite.scopeUrl(galaxy);
      const ctx = new Browser().context(studioPage);
      const inviter = new NebulaClient({
        baseUrl: studioPage, platformOrigin: vite.viteBaseUrl, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
        accessToken: studioToken.accessToken, instanceName: `${studioToken.sub}.${crypto.randomUUID().slice(0, 8)}`,
        fetch: ctx.fetch, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      });
      disposers.push(() => { try { inviter[Symbol.dispose](); } catch { /* already disposed */ } ctx.close(); });
      const ack = await inviter.lmz.callAsync('GALAXY', galaxy,
        inviter.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email: austenEmail, tier: 'write' }]), { timeoutMs: 30_000 }) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      inviteLink = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    assert.ok(inviteLink.startsWith(vite.viteBaseUrl), `the invite links to ${new URL(inviteLink).origin}, Studio's page is ${vite.viteBaseUrl}`);
    const austen = await instrumentedPage(browser);
    await austen.page.goto(inviteLink, { waitUntil: 'domcontentloaded' });
    await austen.page.getByTestId('consent-checkbox').check();
    await austen.page.getByTestId('consent-nickname').fill('Austen');
    await austen.page.getByTestId('consent-accept').click();
    const studioHost = new URL(vite.scopeUrl(galaxy)).hostname;
    await austen.page.waitForURL((u) => u.hostname === studioHost, { timeout: 60_000 });

    const wipeOn = async (page: import('playwright').Page): Promise<{ refused: string | null; succeeded: boolean }> => {
      const button = page.getByRole('button', { name: 'Wipe' });
      await button.waitFor({ state: 'visible', timeout: 60_000 });
      await button.click();
      const refusal = page.getByText(/^Wipe refused:/);
      const success = page.getByText('Wiped the development test data.');
      await Promise.race([
        refusal.first().waitFor({ state: 'visible', timeout: 30_000 }),
        success.first().waitFor({ state: 'visible', timeout: 30_000 }),
      ]).catch(() => { /* neither: reported below */ });
      await sleep(1_000); // a success line logged before a refusal would arrive within this
      return {
        refused: (await refusal.count()) > 0 ? await refusal.first().innerText() : null,
        succeeded: (await success.count()) > 0,
      };
    };
    const austenWipe = await wipeOn(austen.page);
    const passage = `No passage from "${galaxy}" into "${dev}"`;
    record('limb 4 — a collaborator\'s Wipe shows the refusal, and no success',
      austenWipe.refused !== null && austenWipe.refused.includes(passage) && !austenWipe.succeeded,
      `refusal ${JSON.stringify(austenWipe.refused)}; success line ${austenWipe.succeeded ? 'SHOWN' : 'absent'}`);
    const ownerWipe = await wipeOn(owner.page);
    record("limb 4 — the owner's Wipe reports success",
      ownerWipe.succeeded && ownerWipe.refused === null,
      `success line ${ownerWipe.succeeded ? 'shown' : 'absent'}; refusal ${JSON.stringify(ownerWipe.refused)}`);

    // ── LIMB 5: a version change on `.dev` counts the rows its validator refuses ────────────
    // The owner's Wipe left the Star empty, so these five are the only rows it holds.
    const seeded = await openPage(dev, v3!);
    for (const value of [
      { title: 'a', stage: 'won' }, { title: 'b', stage: 'lost' }, { title: 'c' }, { title: 'd' }, { title: 'e' },
    ]) assert.equal(await createDeal(seeded, value), 'committed', `seeding ${value.title} failed`);
    /** Build `types`, open a page on the version it lands, and read the count its install logs. */
    const countAfter = async (types: string): Promise<{ version: string; line: string }> => {
      await write('src/ontology.d.ts', seed + types);
      await build();
      const version = (await servedOntologyVersion(stack, dev))!;
      const reader = await openPage(dev, version);
      // A read, so the op that makes the Star install adds no row to what the next count checks.
      await reader.resources.read('Deal', crypto.randomUUID()).catch(() => null);
      if (!observable) return { version, line: 'not observable on a deployed target' };
      const lines = await waitForDebugLines(stack, (all) => all.some((l) =>
        l.message === 'rows failing the new version' && l.data.instanceName === dev && l.data.version === version),
      `the count for ${version}`).catch(() => debugLines(stack.logs?.() ?? ''));
      const hit = lines.find((l) => l.message === 'rows failing the new version' && l.data.instanceName === dev && l.data.version === version);
      return { version, line: hit ? `${hit.data.failing} of ${hit.data.checked}` : 'no count logged' };
    };
    const control = await countAfter(DEAL_OWNER);
    const retyped = await countAfter(DEAL_STAGE_NUMBER);
    await logHalf('limb 5 — an added optional field counts 0 of 5, and retyping stage counts 2 of 5', async () => [
      control.line === '0 of 5' && retyped.line === '2 of 5',
      `adding owner: ${control.line}; retyping stage: ${retyped.line}`,
    ]);

    // ── LIMB 6: a page current at the new version waits out the change without reloading ─────
    const pipelineId = crypto.randomUUID();
    const pipelineQuery = { queryType: 'parentChild' as const, typeName: 'Deal', field: 'pipeline', value: pipelineId };
    /** A `Pipeline` at `pipeline` and one `Deal` in it, from `client`; returns the Deal's id and outcome. */
    const writePiped = async (client: NebulaClient, pipeline = pipelineId): Promise<[string, string]> => {
      const deal = crypto.randomUUID();
      const outcome = await client.resources.transaction({
        [pipeline]: { op: 'create', typeName: 'Pipeline', nodeId: ROOT_NODE_ID, value: { name: 'Sales' } },
        [deal]: { op: 'create', typeName: 'Deal', nodeId: ROOT_NODE_ID, value: { title: 'piped', pipeline } },
      });
      return [deal, outcome.kind];
    };
    await write('src/ontology.d.ts', seed + DEAL_PIPELINE);
    await build();
    const vP = (await servedOntologyVersion(stack, dev))!;
    let refreshes = 0;
    const current = await openPage(dev, vP, () => { refreshes++; });
    // The list subscription is the first op the `.dev` Star hears since the build, so it still
    // holds the old version: its answer closes the page's gate, and the two row subscriptions sent
    // after it wait there, unsent.
    const list = current.resources.subscribeQuery(pipelineQuery);
    const listAnswer = within(45_000, list.ready); // observed from the start, so a refusal is reported
    const closed = await until(15_000, () => gateClosedFor.has(current.lmz.instanceName));
    const rows = createdDeals.slice(-2).map((id) => current.resources.subscribe('Deal', id));
    const rowsAnswer = within(30_000, Promise.all(rows.map((r) => r.snapshot)));
    const [listTaken, rowsTaken] = [await listAnswer, await rowsAnswer];
    const taken = !closed ? `the gate never closed (the list: ${listTaken})`
      : listTaken !== 'ok' ? `the list: ${listTaken}` : rowsTaken !== 'ok' ? `the rows: ${rowsTaken}` : 'ok';
    const writer = await openPage(dev, vP);
    const [piped, wrotePiped] = await writePiped(writer);
    const sawPiped = await until(15_000, () => list.resourceIds.includes(piped));
    record('limb 6 — a page on the new version takes its subscriptions, with no reload',
      taken === 'ok' && wrotePiped === 'committed' && sawPiped && refreshes === 0,
      `its subscriptions ${taken}; another client's Deal ${wrotePiped}, ${sawPiped ? 'seen' : 'NOT seen'} on its list; ` +
      `onShouldRefreshUI calls ${refreshes}`);
    await logHalf("limb 6 — every subscribe the Star admitted from the page came after its install", async () => {
      const id = current.lmz.instanceName;
      const mine = (all: ReturnType<typeof debugLines>) => all.filter((l) =>
        l.namespace === 'nebula.Resources.subscribe' && l.message === 'arrived' && clientIdIn(l.data) === id);
      const lines = await waitForDebugLines(stack, (all) => mine(all).filter((l) => l.data.stale === false).length >= 3,
        "the page's three admitted subscribes").catch(() => debugLines(stack.logs?.() ?? ''));
      const install = lines.find((l) => l.message === 'installed' && l.data.instanceName === dev && l.data.version === vP);
      const admitted = mine(lines).filter((l) => l.data.stale === false);
      const refused = mine(lines).filter((l) => l.data.stale === true);
      const heldRefused = refused.filter((l) => l.data.kind === 'resource').length;
      const after = install !== undefined && admitted.every((l) => l.idx > install.idx);
      return [install !== undefined && admitted.length >= 3 && refused.length >= 1 && heldRefused === 0 && after,
        `installed ${install ? 'logged' : 'NOT logged'}; the list subscription refused ${refused.length - heldRefused}×, ` +
        `the held rows ${heldRefused}×; ${admitted.length} admitted, ${after ? 'all after the install' : 'SOME BEFORE the install'}`];
    });
    // ── LIMB 7: a wipe drops the page's subscriptions, and the page takes them again ─────────
    // The page holds the two rows from limb 6, its list, and a second list with a Deal in it, so a
    // wipe's restore sends a row first, which the wiped Star refuses as missing once it installs,
    // and the established lists wait behind the gate that row's answer closed.
    const pipeline2 = crypto.randomUUID();
    const list2 = current.resources.subscribeQuery({ ...pipelineQuery, value: pipeline2 });
    const [first2] = await writePiped(writer, pipeline2);
    const list2Ready = await within(30_000, list2.ready);
    const list2Saw = await until(15_000, () => list2.resourceIds.includes(first2));
    assert.ok(list2Ready === 'ok' && list2Saw, `the second list never took its first Deal (${list2Ready})`);
    for (const round of [1, 2]) {
      await studio.client.lmz.callAsync('STAR', dev, studio.client.ctn<Star>().resetDevData(), { timeoutMs: 30_000 });
      // The wipe left no Deals, so an empty list is that list answered again. Within 15 s, well
      // inside the gate's 30 s bound, so a gate let go only at its bound reds here.
      const wiped = Date.now();
      const retaken = await until(15_000, () => list.resourceIds.length === 0 && list2.resourceIds.length === 0);
      const retakenMs = Date.now() - wiped;
      const [deal, wrote] = await writePiped(writer);
      const [deal2, wrote2] = await writePiped(writer, pipeline2);
      const saw = await until(30_000, () => list.resourceIds.includes(deal) && list2.resourceIds.includes(deal2));
      record(`limb 7 — after wipe ${round}, both of the page's lists see Deals written afterwards, with no reload`,
        retaken && wrote === 'committed' && wrote2 === 'committed' && saw && refreshes === 0,
        `lists ${retaken ? `answered again in ${retakenMs} ms` : `NOT answered again within 15 s (${list.resourceIds.length}, ${list2.resourceIds.length} ids)`}; ` +
        `Deals ${wrote}/${wrote2}, ${saw ? 'seen' : 'NOT seen'}; onShouldRefreshUI calls ${refreshes}`);
    }

    // ── LIMB 8: a top-level page on the `.dev` host reloads once per build ───────────────────
    await write('src/nebula.ts', NEBULA_TS_LOGGING_RELOADS);
    await write('src/App.vue', appListing(pipelineId));
    const appBuild = await build();
    assert.ok(appBuild.bundle.ok, `the listing app should bundle: ${JSON.stringify(appBuild).slice(0, 600)}`);
    // In the owner's browser, beside Studio's page and not framed by it.
    const top = await owner.page.context().newPage();
    const reloadLines: string[] = [];
    let loads = 0;
    top.on('console', (m) => { if (m.text().startsWith(`${RELOAD_LINE} `)) reloadLines.push(m.text().slice(RELOAD_LINE.length + 1)); });
    top.on('load', () => { loads++; });
    const deals = top.getByTestId('limb-eight-deals');
    await top.goto(`${vite.scopeUrl(dev)}/`, { waitUntil: 'domcontentloaded' });
    await deals.filter({ hasText: /^\d+$/ }).waitFor({ state: 'visible', timeout: 60_000 });
    const builtFor8: string[] = [];
    for (const types of [DEAL_PIPELINE_B, DEAL_PIPELINE_C]) {
      const loadsBefore = loads;
      await write('src/ontology.d.ts', seed + types);
      await build();
      const version = (await servedOntologyVersion(stack, dev))!;
      builtFor8.push(version);
      // A second client on the new version, so the Star installs it and tells the page.
      const nudge = await openPage(dev, version);
      await nudge.resources.read('Deal', crypto.randomUUID()).catch(() => null);
      await until(30_000, () => reloadLines.includes(version) && loads > loadsBefore);
      await deals.filter({ hasText: /^\d+$/ }).waitFor({ state: 'visible', timeout: 60_000 }).catch(() => { /* reported below */ });
    }
    await sleep(3_000); // a second reload for the same version would arrive within this
    record('limb 8 — a top-level page on the .dev host reloads once per build',
      JSON.stringify(reloadLines) === JSON.stringify(builtFor8) && loads === 1 + builtFor8.length,
      `reload lines ${JSON.stringify(reloadLines)} for builds ${JSON.stringify(builtFor8)}; ${loads} loads`);
    await top.close();

    // ── LIMB 9: on a tenant Star the wait ends, and nothing keeps asking ────────────────────
    const quiet = await openPage(tenant, builtFor8.at(-1)!);
    /** A subscribe with no version: the tenant logs its arrival and asks nobody, so it fences the log. */
    const fence = () => {
      const topic = crypto.randomUUID();
      quiet.lmz.call('STAR', tenant, quiet.ctn<Star>().resources.subscribe('', 'Deal', topic),
        quiet.ctn().logRefusal('fence'), { onErrorOnly: true });
      return topic;
    };
    const fences = [fence()];
    const started = Date.now();
    // Registered, so a refusal that restored would send it again.
    const tenantList = quiet.resources.subscribeQuery(pipelineQuery).ready.then(() => 'answered', staleOrNot);
    const tenantWrite = quiet.resources.transaction({
      [crypto.randomUUID()]: { op: 'create', typeName: 'Deal', nodeId: ROOT_NODE_ID, value: { title: 'never lands' } },
    }).then((o) => o.kind, staleOrNot);
    const waited = await until(10_000, () => gateClosedFor.has(quiet.lmz.instanceName));
    const tenantRead = quiet.resources.read('Deal', crypto.randomUUID()).then(() => 'read', staleOrNot);
    const ended: string[] = [];
    const settled9 = await within(20_000, Promise.all([tenantWrite, tenantRead, tenantList]).then((all) => { ended.push(...all); }));
    const took = Date.now() - started;
    record('limb 9 — on a tenant Star an op, and one sent while it waited, end ontology-stale',
      waited && settled9 === 'ok' && ended.every((k) => k === 'ontology-stale') && took < 12_000,
      `the read was sent ${waited ? 'behind the closed gate' : 'with NO gate closed'}; ` +
      `${settled9 === 'ok' ? `the write, the read and the list ended ${JSON.stringify(ended)}` : settled9}, in ${took} ms`);
    fences.push(fence());
    await sleep(6_000);
    fences.push(fence());
    await logHalf('limb 9 — the tenant asked while the ops waited, and not once in the six seconds after', async () => {
      const at = (all: ReturnType<typeof debugLines>, topic: string) => all.find((l) =>
        l.namespace === 'nebula.Resources.subscribe' && l.message === 'arrived' && l.data.topic === topic)?.idx;
      const lines = await waitForDebugLines(stack, (all) => at(all, fences[2]!) !== undefined, 'the last fence')
        .catch(() => debugLines(stack.logs?.() ?? ''));
      const [f0, f1, f2] = fences.map((t) => at(lines, t));
      if (f0 === undefined || f1 === undefined || f2 === undefined) return [false, `fences logged at ${JSON.stringify([f0, f1, f2])}`];
      const asks = lines.filter((l) => l.namespace === 'nebula.Resources.source' && l.message === 'ask' && l.data.instanceName === tenant);
      const during = asks.filter((l) => l.idx > f0 && l.idx < f1).length;
      const after = asks.filter((l) => l.idx > f1 && l.idx < f2).length;
      return [during >= 1 && after === 0, `${during} asks while the ops waited, ${after} in the six seconds after`];
    });

    const open = results.filter((r) => !r.ok);
    assert.equal(open.length, 0,
      `${open.length} of ${results.length} properties do not hold:\n` + open.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'));
  } finally {
    clearDebugSink();
    for (const d of disposers) { try { d(); } catch { /* already released */ } }
    await browser.close();
    await vite.close();
  }
}
