/**
 * Who a reaper believes, when a reply says somebody else died.
 *
 * A Galaxy fans a resource update to its subscribers with one 4-arg `lmz.call` per target, and every
 * target shares ONE handler chain — `resourcesResults.onBroadcastResult(resourceId)` for a resource
 * subscription, `resourcesResults.onQueryBroadcastResult(queryHash)` for a query — which carries
 * what changed and nothing identifying which target answered. The reaper takes *who died* from the
 * address the push was sent to (`callContext.callee`), never from the reply — the fix
 * `tasks/archive/mesh-entry-and-walk-gaps.md` § *R2* made, after a `ClientDisconnectedError` whose
 * `clientInstanceName` named anyone the replying client liked was the only source. The limbs below
 * show a forged reply cannot pick a victim.
 *
 * ⚠️ **The harm is what this asserts, not a proxy for it.** A reaped subscriber stops receiving
 * pushes and its UI silently goes stale, so each limb changes the resource again and asks who still
 * hears about it. Reading a roster instead would prove less: the roster carries `{ sub, profileId }`
 * by design and two tabs of one person are indistinguishable in it, while the DELETE is exact-match
 * on `(resourceId, clientId)`.
 *
 * ⚠️ **A `Chat`, deliberately, and never a `Message`.** A committed human `Message` is a prompt —
 * `Galaxy`'s post-commit observer starts a real codegen turn on one — so a scenario that fanned out
 * by posting messages would spend minutes of model time per limb and measure the reaper through the
 * noise. Renaming a `Chat` fans out through the same broadcast and starts nothing.
 *
 * ⚠️ **Nothing here is forged except what an attacker really controls.** Every connection is the
 * same REAL login on its own tab (ADR-009 rung 1, the shape the Gateway's own instance-name rule
 * describes), and the only hostile thing is the push handler one of them runs — which is exactly
 * the hand-written client code § *R2* says the attack needs. No token is constructed.
 *
 * ⚠️ **Every limb runs and the verdict comes at the end**, because a scenario normally reddens on
 * its first failing limb and hides the rest (`.claude/rules/live.md`) — and this file's first run is
 * a measurement of which holes are open.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';

export const needsContainer = false;

/** A galaxy-tier scope: two segments, so the GALAXY owns resources and runs the reapers. */
const SCOPE = 'claude-reaper.app';

/** A push crosses one process boundary. Past this it is a failure, not slowness. */
const PUSH_TIMEOUT_MS = 8_000;

/**
 * A tab that COUNTS the pushes it receives, and can be armed to answer one with a forged death
 * notice naming somebody else. `postprocess` restores `name` and copies every own key onto a plain
 * `Error` whatever the constructor, so the reaper's name guard matches and it reads the forged field.
 *
 * ⚠️ **Armed, not hostile from birth.** The initial snapshot arrives through this same handler, so a
 * client that threw from the start would never become a subscriber at all — and every assertion
 * below would then be about a row that was never there.
 */
class ProbeClient extends NebulaClient {
  pushCount = 0;
  hostile = false;
  forgedVictim = '';
  /** How many forged death notices this tab has actually answered with — the limb's own gate. */
  forgedReplies = 0;

  override handleResourceUpdate(resourceType: string, resourceId: string, result: any): void {
    if (this.hostile) {
      this.forgedReplies += 1;
      throw Object.assign(new Error('client went away'), {
        name: 'ClientDisconnectedError',
        clientInstanceName: this.forgedVictim,
      });
    }
    this.pushCount += 1;
    return super.handleResourceUpdate(resourceType, resourceId, result);
  }
}

/**
 * ⚠️ **An override is a NEW function, and the mark lives on the function value — so it does not
 * inherit.** Without this line the Gateway's push reaches the client executor, fails its
 * member-level check, and the subscription's initial snapshot never arrives: the scenario hangs
 * with no subscriber at all. Production spells the decorator `@mesh()`; this file runs under `tsx`,
 * which does not transform TC39 decorators, so it sets the same flag the decorator sets.
 * `MESH_CALLABLE` is a `Symbol.for`, so this is the identical symbol the executor reads.
 */
(ProbeClient.prototype.handleResourceUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;

/**
 * Run one step with a HARD ceiling and a timestamped line.
 *
 * ⚠️ Not decoration: an unbounded await in a scenario is indistinguishable from a slow boot to
 * whoever is watching, which is the failure `.claude/rules/live.md` says made this whole tier LOOK
 * expensive. Every await here is a round trip that should take milliseconds, so a ceiling turns a
 * hang into a sentence naming the step.
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
    console.log(`[reaper] ${name} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Tab {
  client: ProbeClient;
  clientId: string;
  close: () => void;
}

export async function run(stack: DevStack): Promise<void> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  // The login rides a cookie jar, exactly as a browser does — `connectDriver` passes the same thing.
  const loginBrowser = new Browser();
  const { accessToken, sub } = await step('login', 90_000, () => provisionAndLogin({
    baseUrl: origin, scope: SCOPE, testToken: readDevVar('TEST_TOKEN'), fetchImpl: loginBrowser.fetch,
  }));

  const tabs: Tab[] = [];
  const disposers: Array<() => void> = [];
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(56)} ${detail}`);
  };

  const connect = async (): Promise<Tab> => {
    const browser = new Browser();
    const ctx = browser.context(scopeUrlOf(stack, SCOPE));
    const clientId = `${sub}.${crypto.randomUUID().slice(0, 8)}`;
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
    });
    const deadline = Date.now() + 30_000;
    while (client.connectionState !== 'connected') {
      assert.ok(Date.now() < deadline, `a tab never reached connected (state=${client.connectionState})`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const tab: Tab = {
      client, clientId,
      close: () => { try { client[Symbol.dispose](); } catch { /* already disposed */ } ctx.close(); },
    };
    tabs.push(tab);
    return tab;
  };

  try {
    // ── one Chat, and a seeder subscribed to it so its `put` eTags auto-derive ─────────────
    const seeder = await step('seeder connects', 45_000, () => connect());
    const chatId = crypto.randomUUID();
    await step('create the chat', 30_000, () => seeder.client.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'reaper-0' } },
    }));
    const seederSub = seeder.client.resources.subscribe('Chat', chatId);
    disposers.push(() => seederSub[Symbol.dispose]());
    await step('seeder subscribed', 30_000, () => seederSub.snapshot);

    let bumps = 0;
    /** Rename the chat, then report which tabs heard about it. */
    const bumpAndSee = async (watchers: Array<{ label: string; tab: Tab }>) => {
      const before = new Map(watchers.map((w) => [w.label, w.tab.client.pushCount]));
      bumps += 1;
      await step(`rename #${bumps} for [${watchers.map((w) => w.label).join(', ')}]`, 30_000,
        () => seeder.client.resources.transaction({
          [chatId]: { op: 'put', typeName: 'Chat', value: { title: `reaper-${bumps}` } } as any,
        }));
      const deadline = Date.now() + PUSH_TIMEOUT_MS;
      const saw = new Map<string, boolean>();
      for (;;) {
        for (const w of watchers) saw.set(w.label, w.tab.client.pushCount > before.get(w.label)!);
        if ([...saw.values()].every(Boolean) || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      return saw;
    };

    // ── LIMB 1: a reply naming ANOTHER client ─────────────────────────────────────────────
    const victim = await step('victim connects', 45_000, () => connect());
    const attacker = await step('attacker connects', 45_000, () => connect());
    attacker.client.forgedVictim = victim.clientId;
    const victimSub = victim.client.resources.subscribe('Chat', chatId);
    const attackerSub = attacker.client.resources.subscribe('Chat', chatId);
    disposers.push(() => victimSub[Symbol.dispose](), () => attackerSub[Symbol.dispose]());
    await step('both subscriptions ready', 30_000,
      () => Promise.all([victimSub.snapshot, attackerSub.snapshot]));

    // A POSITIVE CONTROL first: without it, "the victim stopped hearing" could mean either
    // subscription was never live, and every assertion below would pass vacuously.
    const both = [{ label: 'victim', tab: victim }, { label: 'attacker', tab: attacker }];
    const baseline = await bumpAndSee(both);
    record('both tabs are live subscribers before anything is forged',
      baseline.get('victim') === true && baseline.get('attacker') === true,
      `victim ${baseline.get('victim') ? 'saw' : 'MISSED'} the control push; attacker ${baseline.get('attacker') ? 'saw' : 'MISSED'} it`);

    // Arm, fan out once so the forged reply lands, then disarm so the forger's own row is readable.
    //
    // ⚠️ **The settle is load-bearing, not politeness.** `bumpAndSee` returns the moment the VICTIM
    // has heard, while the forged reply travels on its own one-way fire-back and the reap happens
    // after that. Asserting straight away raced the reap and read GREEN on a tree where the hole was
    // wide open (measured 2026-09-24, one run apart), which is the shape of a limb that cannot fail.
    attacker.client.hostile = true;
    await bumpAndSee([{ label: 'victim', tab: victim }]);
    await step('the forged reply is answered', 15_000, async () => {
      const deadline = Date.now() + 10_000;
      while (attacker.client.forgedReplies === 0) {
        assert.ok(Date.now() < deadline,
          'the armed tab never answered a push — it is not a live subscriber, so nothing below is measuring the forgery');
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await new Promise((r) => setTimeout(r, 1_500));  // the fire-back, then the reaper's DELETE
    attacker.client.hostile = false;

    const after = await bumpAndSee(both);
    record('a forged reply leaves the NAMED client subscribed', after.get('victim') === true,
      after.get('victim') ? 'the victim still receives pushes' : 'the victim was REAPED by a name it did not choose');
    record('the REPLYING client is the row that goes', after.get('attacker') === false,
      after.get('attacker')
        ? 'the forger kept its own subscription — it reaped someone else instead'
        : 'the forger reaped itself, which it could have done by unsubscribing');

    // ── LIMB 2: the same forged error handed DIRECTLY to the old reaper address ───────────
    //    No reaper is left on the host — they answer through `resourcesResults`, which has no `@mesh()` — so the
    //    call names no member and is refused as ABSENT, and no row changes. Both halves: a refusal
    //    alone would satisfy "no row changed" just as readily, so the MESSAGE is what shows the move.
    //    ⚠️ Its target is a FRESH tab. Reusing limb 1's victim would assert over a row limb 1
    //    already took, so the limb would read as a failure whatever this call did.
    const caller = await step('caller connects', 45_000, () => connect());
    const target = await step('limb-2 target connects', 45_000, () => connect());
    const callerSub = caller.client.resources.subscribe('Chat', chatId);
    const targetSub = target.client.resources.subscribe('Chat', chatId);
    disposers.push(() => callerSub[Symbol.dispose](), () => targetSub[Symbol.dispose]());
    await step('limb-2 subscriptions ready', 30_000,
      () => Promise.all([callerSub.snapshot, targetSub.snapshot]));
    const forged = Object.assign(new Error('client went away'), {
      name: 'ClientDisconnectedError', clientInstanceName: target.clientId,
    });
    let permitted: string;
    try {
      await caller.client.lmz.callAsync(
        'GALAXY', SCOPE,
        (caller.client.ctn() as any).onBroadcastResult(chatId, forged),
        { timeoutMs: 15_000 },
      );
      permitted = 'permitted';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      permitted = /No member named 'onBroadcastResult' exists on this node/.test(message)
        ? 'REFUSED as absent' : `threw: ${message.slice(0, 70)}`;
    }
    const direct = await bumpAndSee([
      { label: 'target', tab: target }, { label: 'caller', tab: caller },
    ]);
    record('a direct call to the old reaper address is refused as ABSENT and changes no row',
      permitted === 'REFUSED as absent' && direct.get('target') === true && direct.get('caller') === true,
      `the call was ${permitted}; the named target ${direct.get('target') ? 'still receives pushes' : 'was REAPED'}, the caller ${direct.get('caller') ? 'still receives pushes' : 'was REAPED'}`);

    // ── LIMB 2b: `resourcesResults` from the wire, on each host, is refused ─────────────────
    //    The response-leg gate has no `@mesh()`, so the entry rule refuses a request that names it —
    //    the Galaxy's reaper, and a `.dev` Star's ontology pull, which a mark would open to any
    //    caller with passage. One member per host is enough: the refusal is at op 0,
    //    `resourcesResults`, before any member is named, and the in-lane `resources-door.test.ts`
    //    covers both hosts. The Star half can fail only on its message, since `onOntologyPulled(null)`
    //    changes nothing even when permitted; the target still hearing is the Galaxy's "nothing
    //    changed" half.
    const refusedOn = async (binding: string, instance: string, chain: unknown): Promise<string> => {
      try {
        await caller.client.lmz.callAsync(binding, instance, chain as never, { timeoutMs: 15_000 });
        return 'permitted';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return /Member 'resourcesResults' is not mesh-callable/.test(message) ? 'refused' : `threw: ${message.slice(0, 70)}`;
      }
    };
    const galaxyReaper = await refusedOn('GALAXY', SCOPE,
      (caller.client.ctn() as any).resourcesResults.onBroadcastResult(chatId, forged));
    const starPull = await refusedOn('STAR', `${SCOPE}.dev`,
      (caller.client.ctn() as any).resourcesResults.onOntologyPulled(null));
    const afterResults = await bumpAndSee([{ label: 'target', tab: target }]);
    record('`resourcesResults` is refused from the wire on each host, and changes no row',
      galaxyReaper === 'refused' && starPull === 'refused' && afterResults.get('target') === true,
      `the Galaxy's reaper was ${galaxyReaper}; the .dev Star's pull was ${starPull}; the target ${afterResults.get('target') ? 'still receives pushes' : 'was REAPED'}`);

    // ── LIMB 3 (green before and after): a GENUINE disconnect IS reaped, and only it ───────
    //    ⚠️ A FRESH bystander for the same reason as limb 2: the cleanup must be shown to take the
    //    disconnected row and no other, which a row an earlier limb already took cannot show.
    const doomed = await step('doomed connects', 45_000, () => connect());
    const bystander = await step('bystander connects', 45_000, () => connect());
    const doomedSub = doomed.client.resources.subscribe('Chat', chatId);
    const bystanderSub = bystander.client.resources.subscribe('Chat', chatId);
    disposers.push(() => doomedSub[Symbol.dispose](), () => bystanderSub[Symbol.dispose]());
    await step('limb-3 subscriptions ready', 30_000,
      () => Promise.all([doomedSub.snapshot, bystanderSub.snapshot]));
    const beforeDrop = await bumpAndSee([
      { label: 'doomed', tab: doomed }, { label: 'bystander', tab: bystander },
    ]);
    const doomedCountAtDeath = doomed.client.pushCount;
    doomed.close();
    await bumpAndSee([{ label: 'bystander', tab: bystander }]);  // the fan-out that finds no socket
    const survivors = await bumpAndSee([{ label: 'bystander', tab: bystander }]);
    // ⚠️ **What this limb can and cannot see.** The subscriber table is DO-internal, so `/live`
    //    cannot read the dropped row directly; what it CAN show is that the cleanup costs nobody
    //    else their subscription, which is the half a wrong callee would break. The row-drop itself
    //    is asserted in-lane, where a 4-arg call to a disconnected client delivers a
    //    `ClientDisconnectedError` to its handler (`packages/mesh/test/continuation-only-feasibility.test.ts`).
    record('a genuinely disconnected client is reaped, and nobody else is',
      beforeDrop.get('doomed') === true
        && doomed.client.pushCount === doomedCountAtDeath
        && survivors.get('bystander') === true,
      `the doomed tab ${beforeDrop.get('doomed') ? 'was live first' : 'was never live'} and heard nothing after closing; the bystander ${survivors.get('bystander') ? 'still receives pushes' : 'was reaped too'}`);

    const open = results.filter((r) => !r.ok);
    assert.equal(open.length, 0,
      `${open.length} of ${results.length} reaper properties do not hold:\n` +
      open.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'));
  } finally {
    for (const d of disposers) { try { d(); } catch { /* already released */ } }
    for (const t of tabs) t.close();
  }
}
