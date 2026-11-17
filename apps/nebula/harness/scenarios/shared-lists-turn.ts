/**
 * **The real model is asked, in one post on a new app, for lists a user shares with others.**
 *
 * This is the turn Larry drove by hand on 2026-11-16, kept so a change to the guidance can be
 * run against the request that showed what it lacked
 * (`tasks/nebula-pre-alpha-fast-follow.md` § *Item 20: Data-bound generation*). O signs up through
 * the rendered screens and types the request into Studio's composer. P is a collaborator whose
 * client watches the thread, so the scenario reads the reply without opening a chat subscription
 * under O's name, which the Galaxy would take for a Studio tab of O's.
 *
 * What is ASSERTED is the pipeline: the agent answers inside the deadline. What the model builds
 * is its choice, so everything else is REPORTED, as a findings table and the turn's whole record
 * in the run's artifacts:
 *
 *  (a) the page creates a node for a list (`createNode` in `src/`);
 *  (b) the ontology keeps no second record of access (`members`, `sharedWith`) and no node id;
 *  (c) no `run_in_tab` call failed;
 *  (d) the turn wiped the test data no more than it was asked to, which is never;
 *  (e) the turn ended of its own accord, with its last build clean and landed;
 *  (f) the dev Star's tree after the turn, to read for a grant on one list's node;
 *  (g) the page's own Share control makes a grant, by `invite` or `setPermission`;
 *  (h) the turn read the `define-the-cast` skill.
 *
 * `needsContainer = true` — the app is built in the build container.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/resources/client';
import { uniqueTestEmail, waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID, StudioClient } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { NodeInviteAck, Snapshot } from '@lumenize/resources';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import { askFrame } from '../lib/ask-frame';
import { refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = true;

/** The loop's own backstop is fourteen minutes, and the reply lands after it. */
const TURN_TIMEOUT_MS = 16 * 60_000;
const COMPOSER = 'Describe a change…';
/** Larry's words, spelling included: the model reads what a person types. */
const REQUEST = 'I want to build a shopping list app. I want users to have multiple shopping lists and I want them to be able to share them with other users. Those shares can either be with write privledges or with read-only ones.';

/** What O says when the first turn asks before building: the plainest reading of the request. */
const ANSWER = "The owner manages the list and who it is shared with. Someone with write access can add, change and check off items, and nothing else. Someone with read-only access can only look. A list shared with me shows under a 'Shared with me' heading. Use your judgment on anything else, and build it.";

type ToolCall = { name: string; args?: Record<string, unknown>; result?: any; error?: string };
type Value = { content?: string; replyTo?: string; thought?: string; codegen?: { rounds?: number; stop?: string; toolCalls?: ToolCall[]; build?: { findings?: unknown } } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ms: number, check: () => Promise<boolean>): Promise<boolean> => {
  for (const deadline = Date.now() + ms; ;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(2_000);
  }
};

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('lists');
  const galaxy = `${universe}.shopping-list`;

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const disposers: Array<() => void> = [];
  try {
    // ── O: a new app, claimed through the rendered sign-up, with Studio open ──
    const o = await instrumentedPage(browser);
    await signUpInBrowser(o, vite.viteBaseUrl, { universe, appSlug: 'shopping-list', email: uniqueTestEmail(), nickname: 'Olive', testToken });
    await o.page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    const oCookie = (await o.page.context().cookies()).find((c) => c.name === `__Host-refresh-token.${universe}`);
    assert.ok(oCookie, "O's sign-up set no refresh cookie for the account");
    const oToken = await refreshAccessToken(stack.baseUrl, { refreshToken: oCookie.value, authScope: universe }, galaxy);
    // O's own client reads the source afterwards. It opens no chat subscription.
    const driver: Driver = await connectDriver(stack, { scope: galaxy, session: oToken, Client: StudioClient });
    disposers.push(() => driver.dispose());
    const galaxyCall = <T>(chain: unknown, timeoutMs = 30_000): Promise<T> =>
      driver.client.lmz.callAsync('GALAXY', galaxy, chain as any, { timeoutMs }) as Promise<T>;

    // ── P: a collaborator whose client watches the thread ──
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
        inviter.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email: pEmail, tier: 'write' }]), { timeoutMs: 30_000 }) as NodeInviteAck;
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
    const pCookie = (await p.page.context().cookies()).find((c) => c.name.startsWith('__Host-refresh-token.'));
    assert.ok(pCookie, "P's acceptance set no refresh cookie");
    const pToken = await refreshAccessToken(stack.baseUrl,
      { refreshToken: pCookie.value, authScope: pCookie.name.slice('__Host-refresh-token.'.length) }, galaxy);
    // P's Studio page is closed, so no tab of P's is open for the Galaxy to ask.
    await p.page.close();
    const watcher: Driver<StudioClient> = await connectDriver(stack, { scope: galaxy, session: pToken, Client: StudioClient });
    disposers.push(() => watcher.dispose());
    const thread = watcher.client.resources.subscribeQuery({ typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } });
    disposers.push(() => thread[Symbol.dispose]());
    await thread.ready;

    // ── The turn ──
    const started = Date.now();
    const ask = async (text: string): Promise<Value> => {
      const composer = o.page.getByPlaceholder(COMPOSER);
      await composer.fill(text);
      await composer.press('Enter');
      let answer: Value | undefined;
      const landed = await until(TURN_TIMEOUT_MS, async () => {
        const all: Array<{ id: string; snap: Snapshot }> = [];
        for (const id of thread.resourceIds) {
          const snap = await watcher.client.resources.read('Message', id) as Snapshot | null;
          if (snap) all.push({ id, snap });
        }
        const post = all.find(({ snap }) => snap.meta.recordedClaims.sub === oToken.sub && (snap.value as Value).content === text);
        answer = post && all.find(({ snap }) => snap.meta.recordedClaims.sub === NEBULA_SUB && (snap.value as Value).replyTo === post.id)?.snap.value as Value | undefined;
        return answer !== undefined;
      });
      assert.ok(landed && answer, `the agent never answered "${text.slice(0, 40)}…" inside ${TURN_TIMEOUT_MS / 60_000} minutes`);
      return answer;
    };
    const wrote = (v: Value) => (v.codegen?.toolCalls ?? []).some((tc) => tc.name === 'write_file' || tc.name === 'edit_file');
    let reply = await ask(REQUEST);
    // Asking first is the `define-ontology` skill's own judgment. The answer is what Larry would
    // say, and the turn that builds is the one the findings read.
    let asked: string | undefined;
    if (!wrote(reply)) {
      asked = reply.content ?? '';
      console.error(`\n[shared-lists-turn] the first turn wrote nothing and asked: ${asked.slice(0, 900)}`);
      reply = await ask(ANSWER);
    }
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);

    // ── What it built, read from the source and from O's own page ──
    const calls = reply.codegen?.toolCalls ?? [];
    const read = (path: string) => galaxyCall<string>(driver.client.ctn<Galaxy>().readSource(path)).catch(() => '');
    const [appVue, ontology, permissions, personas] = await Promise.all(
      ['src/App.vue', 'src/ontology.d.ts', 'docs/permissions.md', 'docs/personas.md'].map(read));
    const written = calls.filter((tc) => tc.name === 'write_file' || tc.name === 'edit_file').map((tc) => String(tc.args?.path));
    const sources = await Promise.all([...new Set(written)].filter((f) => f.startsWith('src/') && f !== 'src/App.vue' && f !== 'src/ontology.d.ts').map(read));
    const allSrc = [appVue, ...sources].join('\n');
    const runs = calls.filter((tc) => tc.name === 'run_in_tab');
    const failedRuns = runs.filter((tc) => tc.error !== undefined || tc.result?.ok !== true);
    const wipes = runs.filter((tc) => /resetDevData/.test(String(tc.args?.code)));
    const builds = calls.filter((tc) => tc.name === 'build');
    const lastBuild = builds.at(-1)?.result;
    const lastFindings = Array.isArray(lastBuild?.typeCheck?.findings) ? lastBuild.typeCheck.findings.length : (lastBuild ? 'not an array' : 'no build');
    const names = calls.map((tc) => tc.name);
    const lastWrite = Math.max(names.lastIndexOf('write_file'), names.lastIndexOf('edit_file'));
    const lastBuildAt = names.lastIndexOf('build');
    const tree = await askFrame(o.page, 'Preview', `
      const t = store.lmz.orgTree.value;
      return {
        nodes: [...t.nodes].map(([id, n]) => ({ id, slug: n.slug })),
        edges: [...t.edges].map(String),
        grants: [...t.permissions].flatMap(([nodeId, m]) => [...m].map(([sub, tier]) => ({ slug: t.nodes.get(nodeId) && t.nodes.get(nodeId).slug, sub, tier }))),
      };
    `).catch(() => undefined);

    const findings: Array<[string, boolean | string, string]> = [
      ['(a)', /\bcreateNode\s*\(/.test(allSrc), 'the page creates a node when it creates a list'],
      ['(b)', !/\b(members|sharedWith|owner|nodeId)\b\s*[?:]/.test(ontology) && !/interface\s+(Share|Membership|Permission)\b/.test(ontology), `the ontology keeps no second record of access and no node id`],
      ['(c)', failedRuns.length === 0, `${failedRuns.length} of ${runs.length} run_in_tab call(s) failed`],
      ['(d)', wipes.length === 0, `${wipes.length} wipe(s), none asked for`],
      ['(e)', reply.codegen?.stop !== 'max-depth' && lastFindings === 0 && lastBuild?.preview?.refreshed === true && lastBuildAt > lastWrite,
        `stop=${reply.codegen?.stop} rounds=${reply.codegen?.rounds} builds=${builds.length} last build findings=${lastFindings} landed=${lastBuild?.preview?.refreshed} built after last write=${lastBuildAt > lastWrite}`],
      ['(g)', /\bclient\.resources\.invite\s*\(|\bsetPermission\s*\(/.test(allSrc), 'the page shares by granting on a node'],
      ['(h)', calls.some((tc) => tc.name === 'read_file' && /define-the-cast/.test(String(tc.args?.path))), 'the turn read the define-the-cast skill'],
      ['(f)', 'see tree', JSON.stringify(tree ?? 'the page did not answer').slice(0, 1200)],
    ];
    console.error(`\n[shared-lists-turn] ${asked === undefined ? 'the turn' : 'the two turns, the first of which asked,'} took ${minutes} min and said: ${(reply.content ?? '').slice(0, 400)}`);
    for (const [limb, pass, note] of findings) console.error(`  ${limb} ${pass === true ? 'pass' : pass === false ? 'FAIL' : pass} · ${note}`);
    for (const tc of calls) {
      if (tc.name === 'run_in_tab') {
        console.error(`  · run_in_tab ${String(tc.args?.tab)}: ${String(tc.args?.code).replace(/\s+/g, ' ').slice(0, 260)}`);
        console.error(`      → ${(tc.error ? `TOOL ERROR ${tc.error}` : JSON.stringify(tc.result)).slice(0, 300)}`);
      } else {
        const findingsOf = tc.name === 'build' ? ` preview=${JSON.stringify(tc.args?.preview)} findings=${JSON.stringify(tc.result?.typeCheck?.findings ?? null).slice(0, 300)} landed=${tc.result?.preview?.refreshed}` : '';
        console.error(`  · ${tc.name} ${JSON.stringify(tc.args?.path ?? '')}${findingsOf}${tc.error ? ` ERROR ${tc.error.slice(0, 200)}` : ''}`);
      }
    }
    const dir = join(import.meta.dirname, '..', '.artifacts', `shared-lists-turn-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reply.json'), JSON.stringify(reply, null, 1));
    writeFileSync(join(dir, 'App.vue'), allSrc);
    writeFileSync(join(dir, 'ontology.d.ts'), ontology);
    writeFileSync(join(dir, 'permissions.md'), permissions);
    writeFileSync(join(dir, 'personas.md'), personas);
    writeFileSync(join(dir, 'tree.json'), JSON.stringify(tree ?? null, null, 1));
    console.error(`[shared-lists-turn] the turn's record is in ${dir}`);
  } finally {
    for (const d of disposers.reverse()) { try { d(); } catch { /* already released */ } }
    await browser.close();
    await vite.close();
  }
}
