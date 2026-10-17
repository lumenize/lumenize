/**
 * **A push that meets an expired token waits for the reconnect**, and one that meets a revoked
 * session never arrives.
 *
 * Two tabs of the app's owner, each signed in through its own cookie jar, subscribe to one Chat and
 * then make no call while their tokens lapse on open sockets. The second tab's session is revoked
 * first, by the logout its page would send. A third tab then renames the Chat, and the tab's host node finds
 * each subscriber's token expired: it closes the socket with 4401 and holds the push, in the grace
 * period that close starts, for the Client to come back with a fresh token.
 *
 *  1. **The live tab receives the push on its new socket, and a later write too.** It refreshed,
 *     reconnected inside the grace period, was told `false`, and re-subscribed nothing, counted on
 *     the host's subscribe marker, so the value came by the push and not by a snapshot. When the
 *     platform resets the host during the wait, every socket drops, and the reconnect that follows is
 *     told `true` and owes a subscribe of its own, so the count is read against what the tab was
 *     told. Mutation: answer at once, and the push is lost.
 *  2. **The revoked tab never receives it.** It cannot refresh, so it never comes back, and its
 *     host node answers `ClientDisconnectedError` when the grace period ends, which reaps its row.
 *     Mutation: drop the expiry check, and the push reaches the revoked socket.
 *
 * Both limbs run, with the verdict at the end (`live-scenarios.md`). `bootVars` sets the shortest
 * supported token lifetime, so the lapse takes about two minutes locally; a deployed target keeps
 * the full fifteen, because no boot sets the var there. Real logins (ADR-009 rung 1).
 * `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { RECOMMENDED_MIN_TTL_SECONDS } from '@lumenize/mesh/client';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { constructionPairs, readDevVar, scopeUrlOf, waitForHost } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { clientIdIn, debugLines, settleForAbsence, waitForDebugLines } from '../lib/stdio';

export const needsContainer = false;
export const bootVars = {
  AUTH_ACCESS_TOKEN_TTL: String(RECOMMENDED_MIN_TTL_SECONDS),
  DEBUG: 'nebula.Resources.subscribers,nebula.Resources.reap',
};

/** A tab that counts the resource pushes it receives. */
class TabClient extends NebulaClient {
  pushes = 0;
  override handleResourceUpdate(resourceType: string, resourceId: string, result: any): void {
    this.pushes += 1;
    return super.handleResourceUpdate(resourceType, resourceId, result);
  }
}
// An override is a new function, and `@mesh()` records itself on the function value, so the flag
// is set again here; `tsx` does not transform TC39 decorators (see `reaper-victim-is-the-address`).
(TabClient.prototype.handleResourceUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;

/**
 * A `WebSocket` that records each `connection_status` its host node sends: whether that connect was
 * told to subscribe again. A host the platform resets while a tab waits tells its reconnect `true`,
 * and the tab rightly subscribes again, so a count of subscribes is read against this record.
 */
function recordingSocket(told: boolean[]): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (e) => {
        try {
          const frame = JSON.parse(String(e.data));
          if (frame.type === 'connection_status') told.push(frame.subscriptionRequired);
        } catch { /* a heartbeat pong is not JSON */ }
      });
    }
  };
}

async function until(ready: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`${what} (after ${ms} ms)`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The `exp` of the token a client holds now. */
const expOf = (client: NebulaClient) => (client.claims as { exp?: number } | null)?.exp ?? 0;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const galaxy = app.galaxy;
  const page = scopeUrlOf(stack, galaxy);
  const failures: string[] = [];
  const limb = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  const disposers: Array<() => void> = [];

  /** A tab of the app's owner on the galaxy's host, signed in through its own cookie jar. */
  const ownerTab = async (told?: boolean[]): Promise<{ tab: TabClient; browser: Browser }> => {
    const browser = new Browser();
    const session = await provisionAndLogin({ baseUrl: origin, scope: galaxy, email: app.ownerEmail, testToken, fetchImpl: browser.fetch });
    await waitForHost(page);
    const ctx = browser.context(page);
    const tab = new TabClient({
      baseUrl: page,
      platformOrigin: origin,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(galaxy),
      accessToken: session.accessToken,
      instanceName: `${session.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      ...(told ? { WebSocket: recordingSocket(told) } : {}),
    });
    disposers.push(() => { try { tab[Symbol.dispose](); } catch { /* already */ } ctx.close(); });
    await until(() => tab.connectionState === 'connected', 30_000, 'a tab never connected');
    return { tab, browser };
  };

  try {
    // ── The Chat both tabs watch, renamed by a third tab of the same owner ──────────────────────
    const { tab: writer } = await ownerTab();
    const chatId = crypto.randomUUID();
    await writer.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'lapse-0' } },
    });
    let renames = 0;
    const rename = async () => {
      renames += 1;
      await writer.resources.transaction({ [chatId]: { op: 'put', typeName: 'Chat', value: { title: `lapse-${renames}` } } as any });
    };

    const liveTold: boolean[] = [];
    const { tab: live } = await ownerTab(liveTold);
    await live.resources.subscribe('Chat', chatId).snapshot;
    const { tab: revoked, browser: revokedBrowser } = await ownerTab();
    await revoked.resources.subscribe('Chat', chatId).snapshot;

    // The revoked tab's session ends, by the logout its page sends; its socket stays open.
    const logout = await revokedBrowser.fetch(`${origin}/auth/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: origin }, body: '{}',
    });
    assert.equal(logout.status, 200, 'the revoked tab\'s logout must succeed');
    await logout.text();

    // ── Both tokens lapse with their sockets open, and neither tab makes a call ──────────────────
    const liveExp = expOf(live);
    const revokedExp = expOf(revoked);
    const waitMs = (Math.max(liveExp, revokedExp) + 5) * 1000 - Date.now();
    console.error(`[push-survives-token-lapse] waiting ${Math.round(waitMs / 1000)} s for both tokens to lapse, sockets open…`);
    await new Promise((r) => setTimeout(r, waitMs));
    // Fixture guards: a tab that had refreshed would meet no expired token, and the limbs would hold
    // on a tree without the wait.
    const now = Math.floor(Date.now() / 1000);
    assert.ok(expOf(live) === liveExp && liveExp < now, 'fixture guard: the live tab\'s token must have lapsed unrenewed');
    assert.ok(expOf(revoked) === revokedExp && revokedExp < now, 'fixture guard: the revoked tab\'s token must have lapsed unrenewed');
    assert.equal(live.connectionState, 'connected', 'fixture guard: the live tab\'s socket must still be open');
    assert.equal(revoked.connectionState, 'connected', 'fixture guard: the revoked tab\'s socket must still be open');

    const liveBefore = live.pushes;
    const revokedBefore = revoked.pushes;
    const toldBefore = liveTold.length;
    await rename();

    // The live tab's push first, then the revoked tab's verdict while the held push is the only one
    // ever sent to it, so its reap can only be that push's. Then the live tab's next write.
    await until(() => live.pushes > liveBefore, 20_000, '').catch(() => {});
    const pushed = live.pushes > liveBefore;
    const renewed = expOf(live) > liveExp;
    // What the reconnect after the 4401 close was told: `false`, since it came back inside the grace period.
    const toldOnReturn = liveTold[toldBefore];

    // ── LIMB 2: the revoked tab never gets it, and the held push reaps its row ──────────────────
    const revokedId = revoked.lmz.instanceName!;
    await until(() => revoked.connectionState === 'disconnected', 15_000, '').catch(() => {});
    await waitForDebugLines(stack, (all) => all.some((l) => l.message === 'update not delivered' && clientIdIn(l.data) === revokedId),
      'the revoked tab\'s reap').catch(() => {});
    const reaped = debugLines(stack.logs()).some((l) => l.message === 'update not delivered' && clientIdIn(l.data) === revokedId
      && l.data.name === 'ClientDisconnectedError');
    const silent = revoked.pushes === revokedBefore;
    // Read afresh: the fixture guard above narrowed the type to the state it asserted then.
    const state: string = revoked.connectionState;

    // ── LIMB 1: the live tab gets the push on its new socket, and the next write ────────────────
    const mid = live.pushes;
    await rename();
    await until(() => live.pushes > mid, 15_000, '').catch(() => {});
    const later = live.pushes > mid;
    // A fresh tab's subscribe is the barrier: once its marker is in, the live tab's would be too, and
    // deployed the settle covers a line from another invocation arriving after it.
    let subscribes: number;
    {
      const { tab: barrier } = await ownerTab();
      await barrier.resources.subscribe('Chat', chatId).snapshot;
      const barrierId = barrier.lmz.instanceName!;
      await waitForDebugLines(stack, (all) => all.some((l) => l.message === 'subscribe-resource'
        && clientIdIn(l.data) === barrierId), 'the barrier subscribe');
      await settleForAbsence();
      subscribes = debugLines(stack.logs()).filter((l) => l.message === 'subscribe-resource'
        && clientIdIn(l.data) === live.lmz.instanceName).length;
    }
    // The first subscribe is the tab's own; each later connect told `true` owes one more, as when the
    // platform resets the host during the wait.
    const owed = 1 + liveTold.slice(1).filter(Boolean).length;
    limb('limb 1 — a push to a tab whose token lapsed', pushed && renewed && later && toldOnReturn === false && subscribes === owed,
      `the push ${pushed ? 'arrived' : 'was LOST'}; token ${renewed ? 'renewed' : 'NOT renewed'}; the next write ${later ? 'arrived' : 'never arrived'}; `
        + `the return was told ${toldOnReturn}; subscribes ${subscribes}, owed ${owed} (told ${JSON.stringify(liveTold)})`);
    limb('limb 2 — a push to a tab whose session was revoked', silent && state === 'disconnected' && reaped,
      `the push ${silent ? 'never arrived' : 'ARRIVED'}; the tab is ${state}; the held push reaped its row: ${reaped}`);
  } finally {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* already */ } }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
