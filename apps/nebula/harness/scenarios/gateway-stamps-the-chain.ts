/**
 * A tab cannot extend the call chain its own call carries.
 *
 * A client's CALL frame used to carry a `callContext.callChain`, and a hostile tab can still write one.
 * A Client's server-side half used to stamp element 0 from the socket's verified attachment and copy every element
 * after it from the frame. Three readers
 * take the LAST element, `callChain.at(-1)`, as the node that called them, so a hop the tab appended
 * became a caller it chose:
 *
 *  1. **The Profile** stores that element's binding as the address it pushes a subscriber's updates
 *     to. A binding absent from `env` makes `lmz.call` throw synchronously at that row on every later
 *     update, and the loop has no per-target catch — so every subscriber ordered after the row stops
 *     hearing, and the writer's own call fails. The Profile's `subscribe` now reads element 0, the
 *     one the host node stamps, so this limb holds unless that read AND the host node both regress:
 *     it no longer singles out the host node, and the two limbs below do.
 *  2. **A data-plane host** stores it the same way. There the throw lands in the fan-out that runs
 *     after a commit, so a write lands and still fails its writer's call.
 *  3. **A tab's own `onBeforeCall`** refuses a push whose last hop is another client. A forged last
 *     hop naming a DO slipped a push from one tab into a co-member's.
 *
 * `ClientGateway.#handleClientCall`, which every host node composes, now builds the chain from the verified origin alone, so
 * each limb below has to hold while the forging tab is still forging.
 *
 * ⚠️ **The only forged thing is what an attacker controls: the bytes its own tab sends.** Every tab
 * is one REAL login (ADR-009 rung 1) on its own connection, as `reaper-victim-is-the-address` does,
 * and every tab is a real `NebulaClient`. The forging tab's injected `WebSocket` writes a
 * forged chain into its outgoing CALL frames — a placeholder origin, then one hop — and nothing else — the rewrite lives in this file, never
 * in a shared helper, because a helper that shapes frames is a fixture.
 *
 * ⚠️ **The data-plane limb runs on the Galaxy's chat plane, not a Star's.** A Star serves resources
 * only for an installed ontology, and installing one takes a container build; the Galaxy's chat
 * ontology self-seeds, and its `Resources` subscribe and post-commit fan-out are the code a
 * Star runs. This keeps the scenario container-free.
 *
 * ⚠️ **Row order is what made the old hole cost a bystander, so it is chosen, not left to chance.**
 * The Profile's `Subscribers` table and the Galaxy's `Subscriptions` table are `WITHOUT ROWID`, the
 * Profile's keyed by `clientAddress` and the Galaxy's by `(kind, topic, clientAddress)`, and each fan-out reads
 * one topic's rows with no `ORDER BY`, which scans key order. The forging tab's name sorts first (`.a-forger`) and the honest tab's last
 * (`.z-honest`), so a throw at the forged row reaches the honest tab. If that order ever changed, the
 * limbs would still hold on a correct tree; only their mutation check would weaken.
 *
 * ⚠️ **Every limb runs and the verdict comes at the end**, because a scenario normally reddens on its
 * first failing limb and hides the rest (`.claude/rules/live.md`). Each limb also gates on the
 * rewrite having actually fired during it — without that, a limb whose frames went out untouched
 * would pass for the wrong reason. The positive control runs first, with the rewrite off, and shows
 * every delivery a limb asserts on can happen at all.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { GatewayMessageType, type NodeIdentity } from '@lumenize/mesh/client';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';

export const needsContainer = false;

/** A galaxy-tier scope: two segments, so the GALAXY owns the chat plane and its subscriber rows. The
 *  run's shared app, set as the scenario starts. */
let SCOPE = '';

/** A push crosses one process boundary. Past this it is a failure, not slowness. */
const PUSH_TIMEOUT_MS = 8_000;

/** A last hop naming a binding the Worker does not declare — `lmz.call` throws at it synchronously. */
const ABSENT_BINDING_HOP: NodeIdentity = {
  type: 'LumenizeDO', bindingName: 'NOT_A_BINDING', instanceName: 'forged',
};

/** A last hop naming a DO, which a tab's own guard accepts as the caller of a push. */
const doHop = (): NodeIdentity => ({ type: 'LumenizeDO', bindingName: 'GALAXY', instanceName: SCOPE });

/**
 * Element 0 of the chain the forging tab writes. An honest frame carries no chain, so a hostile tab
 * writes a whole one. The old server-side half replaced element 0 with the verified origin and copied the rest,
 * so what stands here never mattered: the hop after it is the forgery.
 */
const PLACEHOLDER_ORIGIN: NodeIdentity = {
  type: 'LumenizeClient', bindingName: 'GALAXY', instanceName: 'placeholder/forged.tab',
};

/** The title the forged push carries, so the honest tab can tell it from a real update. */
const FORGED_TITLE = 'forged-by-a-co-member';

/** The hop the forging tab writes after its placeholder origin, and how many frames it has rewritten. */
interface Forge {
  hop: NodeIdentity | null;
  rewritten: number;
}

/**
 * The forging tab's socket: the runtime's own `WebSocket`, whose `send` writes a `callContext.callChain`
 * of {@link PLACEHOLDER_ORIGIN} then `forge.hop` into every outgoing CALL frame while a hop is set.
 * Every other byte is what `NebulaClient` wrote.
 */
function forgingWebSocket(forge: Forge): typeof WebSocket {
  return class ForgingWebSocket extends WebSocket {
    override send(message: Parameters<WebSocket['send']>[0]): void {
      if (forge.hop && typeof message === 'string') {
        const frame = JSON.parse(message);
        if (frame.type === GatewayMessageType.CALL) {
          frame.callContext = {
            ...frame.callContext,
            callChain: [PLACEHOLDER_ORIGIN, forge.hop],
          };
          forge.rewritten += 1;
          message = JSON.stringify(frame);
        }
      }
      super.send(message);
    }
  };
}

/**
 * A tab that COUNTS what reaches it: real chat and profile updates, and the forged push, which it
 * records and does not apply. It forges nothing itself — the forging tab's hostility is all in its
 * socket.
 */
class ProbeClient extends NebulaClient {
  chatId = '';
  chatPushes = 0;
  profilePushes = 0;
  forgedArrivals = 0;

  override handleResourceUpdate(resourceType: string, resourceId: string, result: any): void {
    if (result?.value?.title === FORGED_TITLE) {
      this.forgedArrivals += 1;
      return;
    }
    if (resourceId === this.chatId && !(result instanceof Error)) this.chatPushes += 1;
    return super.handleResourceUpdate(resourceType, resourceId, result);
  }

  override handleProfileUpdate(profileId: string, result: any): void {
    if (result && !(result instanceof Error)) this.profilePushes += 1;
    return super.handleProfileUpdate(profileId, result);
  }
}

/**
 * ⚠️ **An override is a NEW function, and the mark lives on the function value — so it does not
 * inherit.** Production spells the decorator `@mesh()`; this file runs under `tsx`, which does not
 * transform TC39 decorators, so it sets the same flag the decorator sets. Without it the host
 * node's push is refused at the client and no subscription ever delivers.
 */
(ProbeClient.prototype.handleResourceUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;
(ProbeClient.prototype.handleProfileUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;

/**
 * Run one step with a HARD ceiling and a timestamped line. An unbounded await in a scenario is
 * indistinguishable from a slow boot to whoever is watching, so a ceiling turns a hang into a
 * sentence naming the step.
 */
async function step<T>(name: string, ms: number, work: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`step "${name}" did not finish within ${ms}ms`)), ms);
      }),
    ]);
    console.log(`[chain] ${name} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How a call ended, as one short string — a settled value's `kind` if it has one. */
async function outcomeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    const value = await work();
    const kind = (value as { kind?: unknown } | undefined)?.kind;
    return typeof kind === 'string' ? kind : 'ok';
  } catch (err) {
    return `threw: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}`;
  }
}

interface Tab {
  client: ProbeClient;
  clientId: string;
  close: () => void;
}

export async function run(stack: DevStack): Promise<void> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  // The login rides a cookie jar, exactly as a browser does.
  const loginBrowser = new Browser();
  const app = await sharedApp(stack, readDevVar('TEST_TOKEN'));
  SCOPE = app.galaxy;
  const { accessToken, sub } = await step('login', 90_000, () => provisionAndLogin({
    baseUrl: origin, scope: SCOPE, email: app.ownerEmail, testToken: readDevVar('TEST_TOKEN'), fetchImpl: loginBrowser.fetch,
  }));

  const tabs: Tab[] = [];
  const disposers: Array<() => void> = [];
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(62)} ${detail}`);
  };

  /** One more tab of the same login. `tabId` fixes where its subscriber rows sort. */
  const connect = async (tabId: string, forge?: Forge): Promise<Tab> => {
    const browser = new Browser();
    const ctx = browser.context(scopeUrlOf(stack, SCOPE));
    const clientId = `${sub}.${tabId}`;
    const client = new ProbeClient({
      baseUrl: scopeUrlOf(stack, SCOPE),
      platformOrigin: origin,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      resourceHostBinding: 'GALAXY',
      chatHostBinding: 'GALAXY',
      chatScope: SCOPE,
      accessToken,
      instanceName: clientId,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      ...(forge ? { WebSocket: forgingWebSocket(forge) } : {}),
    });
    const deadline = Date.now() + 30_000;
    while (client.connectionState !== 'connected') {
      assert.ok(Date.now() < deadline, `tab ${tabId} never reached connected (state=${client.connectionState})`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const tab: Tab = {
      client, clientId,
      close: () => { try { client[Symbol.dispose](); } catch { /* already disposed */ } ctx.close(); },
    };
    tabs.push(tab);
    return tab;
  };

  /** Run `write`, then wait until each counter moved past where it stood before the write. */
  const writeAndHear = async (
    name: string, write: () => Promise<unknown>, counters: Array<{ label: string; read: () => number }>,
  ): Promise<{ outcome: string; heard: Map<string, boolean> }> => {
    const before = new Map(counters.map((c) => [c.label, c.read()]));
    const outcome = await step(name, 30_000, () => outcomeOf(write));
    const deadline = Date.now() + PUSH_TIMEOUT_MS;
    const heard = new Map<string, boolean>();
    for (;;) {
      for (const c of counters) heard.set(c.label, c.read() > before.get(c.label)!);
      if ([...heard.values()].every(Boolean) || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return { outcome, heard };
  };

  /**
   * Wait, bounded, for a counter to move past `from` — a subscribe's initial snapshot landing.
   * ⚠️ Load-bearing: a snapshot that lands after a write takes its baseline would count as that
   * write being heard, so every subscribe settles here before the next write.
   */
  const moved = async (read: () => number, from: number): Promise<boolean> => {
    const deadline = Date.now() + PUSH_TIMEOUT_MS;
    while (read() === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return read() > from;
  };

  /** Send `work`'s frames with a forged chain ending in `hop`, and report how many frames it touched. */
  const forging = async (forge: Forge, hop: NodeIdentity, work: () => Promise<unknown>) => {
    const before = forge.rewritten;
    forge.hop = hop;
    try {
      return { outcome: await outcomeOf(work), rewrote: forge.rewritten - before };
    } finally {
      forge.hop = null;
    }
  };

  try {
    const forge: Forge = { hop: null, rewritten: 0 };
    const writer = await step('writer connects', 45_000, () => connect('m-writer'));
    const forger = await step('forging tab connects', 45_000, () => connect('a-forger', forge));
    const honest = await step('honest tab connects', 45_000, () => connect('z-honest'));
    const profileId = writer.client.claims.profileId;
    assert.ok(profileId, 'the session carries a profileId claim, so the Profile limb has a profile to write');

    // ── one Chat; the writer subscribes so its `put` eTags derive, the honest tab as any tab does ──
    const chatId = crypto.randomUUID();
    forger.client.chatId = chatId;
    honest.client.chatId = chatId;
    await step('create the chat', 30_000, () => writer.client.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'chain-0' } },
    }));
    const writerChat = writer.client.resources.subscribe('Chat', chatId);
    const honestChat = honest.client.resources.subscribe('Chat', chatId);
    const honestProfile = honest.client.subscribeProfile(profileId);
    disposers.push(
      () => writerChat[Symbol.dispose](), () => honestChat[Symbol.dispose](), () => honestProfile[Symbol.dispose](),
    );
    await step('writer and honest tab subscribed', 30_000,
      () => Promise.all([writerChat.snapshot, honestChat.snapshot, honestProfile.snapshot]));

    // The forging tab subscribes by calling each door itself — its own code is the attacker's, so
    // the positive control and the limbs send the identical call and differ only in the rewrite.
    const subscribeProfile = () => forger.client.lmz.callAsync('PROFILE', profileId,
      forger.client.ctn<{ subscribe(): void }>().subscribe(), { timeoutMs: 15_000 });
    const subscribeChat = () => forger.client.lmz.callAsync('GALAXY', SCOPE,
      forger.client.ctn<Galaxy>().resources.subscribe(CHAT_MESSAGE_ONTOLOGY_VERSION, 'Chat', chatId), { timeoutMs: 15_000 });
    let edits = 0;
    const writeProfile = () => writer.client.updateMyProfile({ nickname: `chain-${++edits}` });
    const renameChat = () => writer.client.resources.transaction({
      [chatId]: { op: 'put', typeName: 'Chat', value: { title: `chain-${++edits}` } } as any,
    });
    const profileCounters = [
      { label: 'forger', read: () => forger.client.profilePushes },
      { label: 'honest', read: () => honest.client.profilePushes },
    ];
    const chatCounters = [
      { label: 'forger', read: () => forger.client.chatPushes },
      { label: 'honest', read: () => honest.client.chatPushes },
    ];
    const saw = (heard: Map<string, boolean>, label: string) => (heard.get(label) ? 'heard' : 'MISSED');

    // ── POSITIVE CONTROL: the rewrite off, and every delivery a limb asserts on happens ──────
    let from = forger.client.profilePushes;
    const controlSubs = [await outcomeOf(subscribeProfile)];
    await moved(() => forger.client.profilePushes, from);
    from = forger.client.chatPushes;
    controlSubs.push(await outcomeOf(subscribeChat));
    await moved(() => forger.client.chatPushes, from);
    const controlProfile = await writeAndHear('control: profile write', writeProfile, profileCounters);
    const controlChat = await writeAndHear('control: chat rename', renameChat, chatCounters);
    record('control: with the rewrite off, every delivery below can happen',
      controlSubs.every((o) => o === 'ok')
        && controlProfile.outcome === 'ok' && [...controlProfile.heard.values()].every(Boolean)
        && controlChat.outcome === 'committed' && [...controlChat.heard.values()].every(Boolean)
        && forge.rewritten === 0,
      `subscribes ${controlSubs.join(' / ')}; profile write ${controlProfile.outcome}, forger ${saw(controlProfile.heard, 'forger')}, honest ${saw(controlProfile.heard, 'honest')}; ` +
      `rename ${controlChat.outcome}, forger ${saw(controlChat.heard, 'forger')}, honest ${saw(controlChat.heard, 'honest')}; ` +
      `the honest tab's handler counts real pushes, so "never runs" below is not vacuous`);

    // ── LIMB 1: Profile — a subscribe whose last hop names a binding absent from `env` ───────
    from = forger.client.profilePushes;
    const profileForged = await forging(forge, ABSENT_BINDING_HOP, subscribeProfile);
    const profileSnapshot = await moved(() => forger.client.profilePushes, from);
    const profileAfter = await writeAndHear('profile write after the forged subscribe', writeProfile, profileCounters);
    record('Profile: a forged hop leaves every subscriber hearing the next update',
      profileForged.rewrote > 0 && profileAfter.outcome === 'ok'
        && profileAfter.heard.get('forger') === true && profileAfter.heard.get('honest') === true,
      `${profileForged.rewrote} frame(s) forged; the forged subscribe ${profileForged.outcome}, ` +
      `its snapshot ${profileSnapshot ? 'arrived' : 'NEVER arrived'}; ` +
      `the write ${profileAfter.outcome}; forger ${saw(profileAfter.heard, 'forger')}, honest ${saw(profileAfter.heard, 'honest')}`);

    // ── LIMB 2: data-plane host — the same hop on a Chat subscribe ───────────────────────────
    from = forger.client.chatPushes;
    const chatForged = await forging(forge, ABSENT_BINDING_HOP, subscribeChat);
    await moved(() => forger.client.chatPushes, from);
    const chatAfter = await writeAndHear('chat rename after the forged subscribe', renameChat, chatCounters);
    record('data-plane host: a forged hop leaves a commit whole and heard',
      chatForged.rewrote > 0 && chatAfter.outcome === 'committed'
        && chatAfter.heard.get('forger') === true && chatAfter.heard.get('honest') === true,
      `${chatForged.rewrote} frame(s) forged; the forged subscribe ${chatForged.outcome}; ` +
      `the rename ${chatAfter.outcome}; forger ${saw(chatAfter.heard, 'forger')}, honest ${saw(chatAfter.heard, 'honest')}`);

    // ── LIMB 3: tab guard — a push into a co-member's tab whose last hop names a DO ──────────
    //    The refusal is matched on its MESSAGE: a host node's refusal, a timeout and the tab's own
    //    refusal are indistinguishable as booleans, and only the last one is the guard working.
    const pushed = await forging(forge, doHop(), () => forger.client.lmz.callAsync('GALAXY', `${SCOPE}/${honest.clientId}`,
      forger.client.ctn<NebulaClient>().handleResourceUpdate('Chat', chatId,
        { value: { title: FORGED_TITLE }, meta: { typeName: 'Chat', eTag: 'forged' } } as any),
      { timeoutMs: PUSH_TIMEOUT_MS }));
    record("tab guard: a forged DO hop does not get a push into a co-member's tab",
      pushed.rewrote > 0 && honest.client.forgedArrivals === 0
        && /Direct client-to-client calls are disabled/.test(pushed.outcome),
      `${pushed.rewrote} frame(s) forged; the honest tab ran the forged push ${honest.client.forgedArrivals} time(s); ` +
      `the push ${pushed.outcome}`);

    const open = results.filter((r) => !r.ok);
    assert.equal(open.length, 0,
      `${open.length} of ${results.length} chain properties do not hold:\n` +
      open.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'));
  } finally {
    for (const d of disposers) { try { d(); } catch { /* already released */ } }
    for (const t of tabs) t.close();
  }
}
