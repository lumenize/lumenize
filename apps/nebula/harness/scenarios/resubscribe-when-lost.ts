/**
 * **A Client re-subscribes exactly when the Gateway says it lost something** — never on a blip, a
 * supersede or a token rotation inside the grace period.
 *
 * Seven limbs, all run, with the verdict at the end (`live-scenarios.md`). Each drives a product
 * path. What no product path makes happen on demand happens at the edge: a debugger pause through
 * Playwright's CDP session for a tab the browser suspends, and a scenario-local socket for a
 * reconnect the network holds back. ⚠️ CDP's `Page.setWebLifecycleState: frozen` is NOT a freeze
 * here: measured 2026-10-05, a page so frozen kept answering every push over its socket, so limb 1
 * passed with no 4408 close at all. `Debugger.pause` stops the page's script until it resumes.
 *  1. **Studio, frozen past the Gateway's 30 s wait, is closed with 4408**, wakes inside the grace
 *     period, re-subscribes, and renders the next message. Mutation: no 4408 close.
 *  2. **A token rotation re-subscribes nothing**, counted on the host's subscribe marker, and the
 *     next write arrives. Mutation: restore the blanket re-subscribe on reconnect.
 *  3. **A reconnect held 2 s**: the push sent in the gap arrives on the new socket, the tab is told
 *     `false`, and it re-subscribes nothing. Mutation: answer at once instead of waiting.
 *  4. **A reconnect held 8 s, past the 5 s grace period**: the tab is told `true`, re-subscribes and
 *     receives the next write, and the reaper's receipt shows the push sent while it was away reaped
 *     its row. Mutation: report `false`.
 *  5. **A second connection under the same name** closes the first with 4409, is told `false`, and
 *     the next push arrives on it. Mutation: report `true` on a supersede.
 *  6. **A member promoted to admin while subscribed** sees a Chat only an admin may read once the
 *     tab's token refreshes, with no reload. Mutation: skip the `scopeAdmin` comparison.
 *  7. **Accepting a broader membership in another tab** moves this tab to its new `sub`, and it keeps
 *     receiving updates. Mutation: keep the first name, and the tab loops on 403.
 *
 * Limbs 2, 6 and 7 wait for a real token to come due: `bootVars` sets the shortest supported
 * lifetime, so a call 90 s after a token's mint rotates its socket. Those tabs open first and wait
 * while the other limbs run. Real logins throughout (ADR-009 rung 1); a member arrives by a real
 * invite email. The log halves need the local stack's capture, so on a deployed target each says
 * so. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail, extractMagicLink } from '@lumenize/email-test/client';
import { RECOMMENDED_MIN_TTL_SECONDS } from '@lumenize/nebula-auth/claims';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, constructionPairs, readDevVar, scopeUrlOf, waitForHost, NEW_HOST_TIMEOUT_MS } from '../lib/harness';
import { provisionAndLogin, refreshAccessToken, acceptInviteAndLogin, foundTenantStar } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';
import { debugLines, waitForDebugLines } from '../lib/stdio';
import { bootStudioVite, launchChromium, instrumentedPage, captureArtifacts } from '../lib/browser';

export const needsContainer = false;
export const bootVars = {
  NEBULA_AUTH_ACCESS_TOKEN_TTL: String(RECOMMENDED_MIN_TTL_SECONDS),
  DEBUG: 'nebula.Resources.subscribers,nebula.Resources.reap',
};

/** A tab that counts the resource pushes it receives and keeps the last one. */
class TabClient extends NebulaClient {
  pushes = 0;
  last: unknown;
  override handleResourceUpdate(resourceType: string, resourceId: string, result: any): void {
    this.pushes += 1;
    this.last = result;
    return super.handleResourceUpdate(resourceType, resourceId, result);
  }
}
// An override is a new function, and `@mesh()` records itself on the function value, so the flag
// is set again here; `tsx` does not transform TC39 decorators (see `reaper-victim-is-the-address`).
(TabClient.prototype.handleResourceUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;

/** What a scenario-local socket recorded, and what it will do next. */
interface SocketLog {
  /** Every `connection_status` the Client was told, in order. */
  statuses: boolean[];
  /** Hold the next socket's opening by this long, as a network slow to come back would. */
  holdMs: number;
  /** The newest stand-in, which can drop as a network does. */
  current?: { drop(): void };
}

/**
 * A `WebSocket` stand-in over a real one: it can open late, and it records each
 * `connection_status`. It implements what `LumenizeClient` uses of a socket and nothing more.
 */
function socketFor(log: SocketLog): typeof WebSocket {
  return class ScenarioSocket {
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    #ws?: WebSocket;
    constructor(url: string, protocols?: string | string[]) {
      log.current = this;
      const open = () => {
        const ws = new WebSocket(url, protocols);
        this.#ws = ws;
        ws.onopen = (e) => { this.readyState = 1; this.onopen?.(e); };
        ws.onmessage = (e) => {
          try {
            const frame = JSON.parse(String(e.data));
            if (frame.type === 'connection_status') log.statuses.push(frame.subscriptionRequired);
          } catch { /* a heartbeat pong is not JSON */ }
          this.onmessage?.(e);
        };
        ws.onclose = (e) => { this.readyState = 3; this.onclose?.(e); };
        ws.onerror = (e) => this.onerror?.(e);
      };
      const hold = log.holdMs;
      log.holdMs = 0;
      if (hold > 0) setTimeout(open, hold); else open();
    }
    /**
     * Lose the connection as a network does: the Client hears an abnormal close at once, and the
     * real socket is closed so the Gateway sees it go. Its own close event, if one ever comes, is
     * not passed on a second time.
     */
    drop(): void {
      const ws = this.#ws;
      if (!ws) return;
      ws.onclose = null;
      ws.onmessage = null;
      ws.close(4000, 'the network dropped');
      this.readyState = 3;
      this.onclose?.(new CloseEvent('close', { code: 1006, reason: '' }));
    }
    send(data: string): void { this.#ws?.send(data); }
    close(code?: number, reason?: string): void {
      if (this.#ws) this.#ws.close(code, reason); else this.readyState = 3;
    }
  } as unknown as typeof WebSocket;
}

async function until(ready: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`${what} (after ${ms} ms)`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const galaxy = app.galaxy;
  const failures: string[] = [];
  const limb = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  const disposers: Array<() => void> = [];
  /** Every client this scenario opens itself, so a reap of anyone else's row is the Studio page's. */
  const ours = new Set<string>();

  /** A tab on `scope`'s host, renewing through `browser`'s cookie jar as a page does. */
  const openTab = async (browser: Browser, scope: string, session: { accessToken: string; sub: string },
    extra: { WebSocket?: typeof WebSocket; instanceName?: string; onTree?: () => void } = {}): Promise<TabClient> => {
    await waitForHost(scopeUrlOf(stack, scope));
    const ctx = browser.context(scopeUrlOf(stack, scope));
    const client = new TabClient({
      baseUrl: scopeUrlOf(stack, scope),
      platformOrigin: origin,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(scope),
      accessToken: session.accessToken,
      instanceName: extra.instanceName ?? `${session.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      ...(extra.WebSocket ? { WebSocket: extra.WebSocket } : {}),
    });
    // Registered before the first connection, as a page's store does, so its first restore subscribes the tree.
    if (extra.onTree) client.onOrgTreeUpdate(extra.onTree);
    disposers.push(() => { try { client[Symbol.dispose](); } catch { /* already */ } ctx.close(); });
    await until(() => client.connectionState === 'connected', 30_000, `a tab on ${scope} never connected`);
    ours.add(client.lmz.instanceName!);
    return client;
  };

  /** A member of `scope`, invited by the owner and accepted through `browser`, so its jar renews. */
  const invitedMember = async (owner: Driver, browser: Browser, scope: string, email: string, scopeAdmin = false) => {
    const waiter = waitForEmail({ testToken, instance: scope, to: email, timeout: 60_000 });
    let link: string;
    try {
      const summary = await owner.client.invite(scope, [{ email, scopeAdmin }]);
      assert.equal(summary.errors.length, 0, `invite into ${scope} failed: ${JSON.stringify(summary.errors)}`);
      const html = (await waiter.emailPromise).html ?? '';
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(html)?.[1];
      assert.ok(href, `the invite into ${scope} carried no link`);
      link = href.replace(/&amp;/g, '&');
    } finally {
      waiter.cleanup();
    }
    const { refreshToken } = await acceptInviteAndLogin({ baseUrl: origin, inviteLink: link, scope, fetchImpl: browser.fetch });
    return refreshAccessToken(origin, { refreshToken, authScope: scope }, scope);
  };

  /** How many subscribes the host logged for `clientId`, once a later line has arrived. */
  const subscribesOf = async (clientId: string, barrierClientId: string): Promise<number | undefined> => {
    if (!stack.logs) return undefined;
    const lines = await waitForDebugLines(stack, (all) => all.some((l) => l.message === 'subscribe-resource'
      && l.data.clientId === barrierClientId), 'the barrier subscribe');
    return lines.filter((l) => l.message === 'subscribe-resource' && l.data.clientId === clientId).length;
  };

  /** A tab of the app's owner, signed in through its own cookie jar, so it renews past the
   *  scenario's short token lifetime as a page does. */
  const ownerTab = async (extra: Parameters<typeof openTab>[3] = {}) => {
    const browser = new Browser();
    const session = await provisionAndLogin({ baseUrl: origin, scope: galaxy, email: app.ownerEmail, testToken, fetchImpl: browser.fetch });
    return openTab(browser, galaxy, session, extra);
  };

  // The owner invites and edits the tree; signed in without a session, so it renews too.
  const owner = await connectDriver(stack, { scope: galaxy, email: app.ownerEmail });
  disposers.push(() => owner.dispose());
  ours.add(owner.client.lmz.instanceName!);
  try {
    // ── The Chat every galaxy limb watches, renamed by a seeder that is subscribed to it ──────────
    const seeder = await ownerTab();
    const chatId = crypto.randomUUID();
    await seeder.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'resub-0' } },
    });
    await seeder.resources.subscribe('Chat', chatId).snapshot;
    let renames = 0;
    const rename = async () => {
      renames += 1;
      await seeder.resources.transaction({ [chatId]: { op: 'put', typeName: 'Chat', value: { title: `resub-${renames}` } } as any });
    };
    /** A fresh tab subscribing to the Chat: its subscribe marker is a barrier for counting others'. */
    const barrierTab = async () => {
      const tab = await ownerTab();
      await tab.resources.subscribe('Chat', chatId).snapshot;
      return tab;
    };

    // ── Tabs for the limbs that wait on a token coming due, opened first ─────────────────────────
    // Limb 2: the owner, renewing through its own jar.
    const tab2 = await ownerTab();
    await tab2.resources.subscribe('Chat', chatId).snapshot;

    // Limb 6: a plain member, and a Chat on a node no grant reaches, which only dominion reads.
    const browser6 = new Browser();
    const email6 = uniqueTestEmail();
    const member6 = await invitedMember(owner, browser6, galaxy, email6);
    const tab6 = await openTab(browser6, galaxy, member6);
    const adminsNode = await owner.client.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'admins', 'Admins');
    const adminChat = crypto.randomUUID();
    await owner.client.resources.transaction({
      [adminChat]: { op: 'create', typeName: 'Chat', nodeId: adminsNode, value: { title: 'admins only' } },
    });
    const sub6 = tab6.resources.subscribe('Chat', adminChat);
    await until(() => tab6.pushes > 0, 15_000, 'the member\'s subscribe was never answered');
    const deniedFirst = (tab6.last as { deniedNodes?: string[] } | null)?.deniedNodes !== undefined;
    void sub6.snapshot.catch(() => { /* a denied first answer may reject it; the push is what counts */ });

    // Limb 7: a plain member of a tenant Star, on the Star's host, watching its tree.
    const star = `${galaxy}.${testSlug('resub')}`;
    assert.notEqual(await foundTenantStar({ baseUrl: origin, star, testToken }), null, `claim-star found ${star} already claimed`);
    const browser7 = new Browser();
    const email7 = uniqueTestEmail();
    const member7 = await invitedMember(owner, browser7, star, email7);
    let trees7 = 0;
    const tab7 = await openTab(browser7, star, member7, { onTree: () => { trees7 += 1; } });
    await until(() => trees7 > 0, 15_000, 'the tenant tab never received its tree');

    // The changes limbs 6 and 7 wait to see: a promotion, and a broader membership accepted in
    // another tab of the same browser.
    await owner.client.invite(galaxy, [{ email: email6, scopeAdmin: true }]);
    await invitedMember(owner, browser7, galaxy, email7, true);

    // ── LIMB 3: a reconnect held 2 s, inside the grace period ────────────────────────────────────
    {
      const log: SocketLog = { statuses: [], holdMs: 0 };
      const tab = await ownerTab({ WebSocket: socketFor(log) });
      await tab.resources.subscribe('Chat', chatId).snapshot;
      const id = tab.lmz.instanceName!;
      const pushesBefore = tab.pushes;
      log.holdMs = 2_000;
      log.current!.drop();
      await until(() => tab.connectionState === 'reconnecting', 5_000, 'limb 3: the tab never saw its socket drop');
      await rename(); // sent while the tab is away, inside the grace period
      await until(() => tab.connectionState === 'connected', 15_000, 'limb 3: the tab never came back');
      await until(() => tab.pushes > pushesBefore, 10_000, 'limb 3: the push sent in the gap never arrived').catch(() => {});
      const subscribes = await subscribesOf(id, (await barrierTab()).lmz.instanceName!);
      const ok = tab.pushes > pushesBefore && log.statuses.at(-1) === false && (subscribes === undefined || subscribes === 1);
      limb('limb 3 — a reconnect held 2 s', ok,
        `push in the gap ${tab.pushes > pushesBefore ? 'arrived' : 'LOST'}; told ${log.statuses.at(-1)}; subscribes ${subscribes ?? '(not observable)'} (1 is the first)`);
    }

    // ── LIMB 4: a reconnect held 8 s, past the 5 s grace period ─────────────────────────────────
    {
      const log: SocketLog = { statuses: [], holdMs: 0 };
      const tab = await ownerTab({ WebSocket: socketFor(log) });
      await tab.resources.subscribe('Chat', chatId).snapshot;
      const id = tab.lmz.instanceName!;
      log.holdMs = 8_000;
      log.current!.drop();
      await until(() => tab.connectionState === 'reconnecting', 5_000, 'limb 4: the tab never saw its socket drop');
      await rename(); // answered ClientDisconnectedError once the grace period runs out
      await until(() => tab.connectionState === 'connected', 20_000, 'limb 4: the tab never came back');
      await until(() => log.statuses.length === 2, 5_000, 'limb 4: no connection_status on the reconnect');
      // Its re-subscribe answers with a snapshot; the next write must arrive on the new row.
      await new Promise((r) => setTimeout(r, 1_000));
      const pushesBefore = tab.pushes;
      await rename();
      await until(() => tab.pushes > pushesBefore, 10_000, '').catch(() => {});
      let reaped: boolean | undefined;
      if (stack.logs) {
        await waitForDebugLines(stack, (all) => all.some((l) => l.message === 'update not delivered' && l.data.clientId === id), 'limb 4\'s reap')
          .catch(() => {});
        reaped = debugLines(stack.logs()).some((l) => l.message === 'update not delivered' && l.data.clientId === id
          && l.data.name === 'ClientDisconnectedError');
      }
      const ok = log.statuses.at(-1) === true && tab.pushes > pushesBefore && reaped !== false;
      limb('limb 4 — a reconnect held 8 s, past the grace period', ok,
        `told ${log.statuses.at(-1)}; next write ${tab.pushes > pushesBefore ? 'arrived' : 'LOST'}; the gap's push reaped the row: ${reaped ?? '(not observable)'}`);
    }

    // ── LIMB 5: a second connection under the same name ──────────────────────────────────────────
    {
      const first = await ownerTab();
      await first.resources.subscribe('Chat', chatId).snapshot;
      const log: SocketLog = { statuses: [], holdMs: 0 };
      const second = await ownerTab({ WebSocket: socketFor(log), instanceName: first.lmz.instanceName! });
      // The first was closed with 4409; dispose it before its reconnect supersedes the second.
      await until(() => first.connectionState === 'reconnecting', 5_000, 'limb 5: the first tab was never superseded');
      first[Symbol.dispose]();
      const pushesBefore = second.pushes;
      await rename();
      await until(() => second.pushes > pushesBefore, 10_000, '').catch(() => {});
      limb('limb 5 — a second connection under the same name', log.statuses[0] === false && second.pushes > pushesBefore,
        `the second was told ${log.statuses[0]}; the next push ${second.pushes > pushesBefore ? 'arrived on it' : 'never arrived'}`);
    }

    // ── LIMB 1: Studio, frozen past the Gateway's 30 s wait ──────────────────────────────────────
    await (async () => {
      const universe = testSlug('resub');
      const scope = `${universe}.app`;
      const email = uniqueTestEmail();
      const session = await provisionAndLogin({ baseUrl: origin, scope, email, testToken });
      const writer = await connectDriver(stack, { scope, session });
      disposers.push(() => writer.dispose());
      ours.add(writer.client.lmz.instanceName!);
      const { viteBaseUrl, scopeUrl, close: closeVite } = await bootStudioVite(stack.baseUrl);
      const browser = await launchChromium();
      try {
        const inst = await instrumentedPage(browser);
        const { page } = inst;
        await page.goto(`${viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });
        const waiter = waitForEmail({ testToken, instance: '_scopeless', to: email, timeout: 120_000 });
        let link: string;
        try {
          await page.getByPlaceholder('you@example.com').fill(email);
          await page.getByRole('button', { name: /Email me a link/ }).click();
          link = extractMagicLink(await waiter.emailPromise);
        } finally {
          waiter.cleanup();
        }
        await page.goto(link, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('link-continue').click();
        await page.waitForURL((u) => u.origin === scopeUrl(scope), { timeout: NEW_HOST_TIMEOUT_MS });
        await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });

        // Paused: the page runs no script, so the push for the first message is never answered.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Debugger.enable');
        await cdp.send('Debugger.pause');
        const first = `frozen-${Date.now()}`;
        // Resumed as soon as the Gateway gives up on the page, seen as the reap of its row, so it
        // reconnects inside the grace period and only a signal of the loss makes it re-subscribe.
        // A deployed target has no capture to watch, so it waits past the 30 s and the grace period.
        const isReap = (l: { message: string; data: Record<string, unknown> }) => l.message === 'update not delivered'
          && l.data.name === 'ClientDisconnectedError' && !ours.has(String(l.data.clientId));
        const reapsBefore = stack.logs ? debugLines(stack.logs()).filter(isReap).length : 0;
        await writer.client.postUserMessage(first);
        if (stack.logs) {
          await waitForDebugLines(stack, (all) => all.filter(isReap).length > reapsBefore, 'the paused page\'s reap', 45_000);
        } else {
          await new Promise((r) => setTimeout(r, 35_000));
        }
        await cdp.send('Debugger.resume');
        await cdp.send('Debugger.disable');

        // Awake: the 4408 close makes it reconnect, and the Gateway tells that connection the
        // subscriptions may be gone, so the next message renders.
        await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });
        await new Promise((r) => setTimeout(r, 3_000));
        const second = `awake-${Date.now()}`;
        await writer.client.postUserMessage(second);
        let rendered = true;
        try {
          await page.getByText(second).first().waitFor({ state: 'visible', timeout: 20_000 });
        } catch {
          rendered = false;
          await captureArtifacts(inst, 'resubscribe-studio-after-freeze');
        }
        limb('limb 1 — Studio, frozen past the 30 s wait', rendered,
          rendered ? 'it re-subscribed when it woke and rendered the next message' : 'the next message never rendered');
      } finally {
        await browser.close().catch(() => {});
        await closeVite();
      }
    })();

    // ── LIMBS 2, 6, 7: the tabs whose tokens have been coming due all this while ────────────────
    const dueAt = (client: NebulaClient) => ((client.claims as { exp?: number } | null)?.exp ?? 0) - 30;
    const waitDue = async (client: NebulaClient) => {
      const ms = (dueAt(client) + 1) * 1000 - Date.now();
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    };

    // LIMB 2: the rotation re-subscribes nothing, and the next write arrives.
    {
      await waitDue(tab2);
      const id = tab2.lmz.instanceName!;
      await tab2.lmz.callAsync('GALAXY', galaxy, (tab2.ctn() as any).resources.orgTree.getState());
      await until(() => tab2.connectionState === 'connected', 15_000, 'limb 2: the rotated tab never reconnected');
      const subscribes = await subscribesOf(id, (await barrierTab()).lmz.instanceName!);
      const pushesBefore = tab2.pushes;
      await rename();
      await until(() => tab2.pushes > pushesBefore, 10_000, '').catch(() => {});
      limb('limb 2 — a token rotation', (subscribes === undefined || subscribes === 1) && tab2.pushes > pushesBefore,
        `subscribes ${subscribes ?? '(not observable)'} (1 is the first); the next write ${tab2.pushes > pushesBefore ? 'arrived' : 'never arrived'}`);
    }

    // LIMB 6: the promoted member sees the admins' Chat once its token refreshes.
    {
      await waitDue(tab6);
      await tab6.lmz.callAsync('GALAXY', galaxy, (tab6.ctn() as any).resources.orgTree.getState());
      const seen = () => {
        const last = tab6.last as { value?: { title?: string } } | null;
        return last?.value?.title === 'admins only';
      };
      await until(seen, 15_000, '').catch(() => {});
      limb('limb 6 — a member promoted while subscribed', deniedFirst && seen(),
        `first answer ${deniedFirst ? 'denied' : 'NOT denied — the fixture is wrong'}; after the refresh the Chat is ${seen() ? 'visible' : 'still hidden'}`);
    }

    // LIMB 7: the tenant tab moves to its new sub, and keeps receiving updates.
    {
      const before = tab7.lmz.instanceName!;
      await waitDue(tab7);
      await tab7.lmz.callAsync('STAR', star, (tab7.ctn() as any).resources.orgTree.getState()).catch(() => {});
      await until(() => tab7.connectionState === 'connected' && tab7.lmz.instanceName !== before, 20_000, '').catch(() => {});
      const moved = tab7.lmz.instanceName !== before;
      const treesBefore = trees7;
      await owner.client.lmz.callAsync('STAR', star,
        (owner.client.ctn() as any).resources.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'later', 'Later'));
      await until(() => trees7 > treesBefore, 15_000, '').catch(() => {});
      limb('limb 7 — a broader membership accepted in another tab', moved && trees7 > treesBefore,
        `the tab ${moved ? `moved to ${tab7.lmz.instanceName}` : 'kept its first name'}; the next tree change ${trees7 > treesBefore ? 'arrived' : 'never arrived'}`);
    }
  } finally {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* already */ } }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
