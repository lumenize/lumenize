/**
 * **A Star serves its Galaxy's CURRENT ontology — a stale tab cannot move it, and a revert is
 * served.** Every data op names the ontology version the client was built against, and a Star
 * holds one installed version. When they differ, the Star must ask its Galaxy what is current and
 * converge on THAT — never on whatever version the asking tab happens to carry.
 *
 * Both limbs are driven on real infrastructure: two real Applies on the parent Galaxy (a container
 * compile each), real tabs on two real Stars, and the Star's own lazy pull. Nothing is installed by
 * hand, so there is no fixture to build in the wrong shape.
 *
 *  1. **A stale tab cannot move the Star off the current version.** A tab still on v1 after v2 was
 *     applied — a collaborator's preview, say, since a build reloads only the requester's — asks the
 *     tenant Star for something. It is answered `OntologyStaleError`, and the Star stays on v2: a
 *     v2 tab's subscription still hears the next write, and a type only v2 defines still validates.
 *     The failure this guards is a Star that installs the stale tab's version: it drops every
 *     subscriber and validates current tabs against the old schema.
 *  2. **A reverted ontology is served.** The `.dev` Star installs v1 and then v2; the source file is
 *     written back to v1's exact bytes, which makes v1 current again with no second Apply. A tab on
 *     v1 then commits. The failure this guards is a Star whose record of what is installed still
 *     says v2 after it installed v1, so the tab is answered `installing` until it gives up.
 *
 * Each limb carries its own positive control, and every limb is RECORDED rather than asserted in
 * turn, so the first red one cannot hide a later one's result.
 *
 * `needsContainer = true` — each Apply compiles the ontology in the build container.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import type { Galaxy } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf, waitForHost, NEW_HOST_TIMEOUT_MS } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { provisionAndLogin, refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = true;

/** How long a write may take to reach a subscriber before the scenario calls it unheard. */
const PUSH_TIMEOUT_MS = 8_000;

/** v2 adds a type and changes nothing else — additive, so the Apply needs no wipe. */
const TAG_TYPE = '\n/** @title Tag */\nexport interface Tag {\n  /** @title Label */\n  label: string;\n}\n';

/**
 * A tab that counts the real pushes it receives for one resource. The notice a Star sends a
 * subscriber it has just dropped carries an Error and names no resource, so it never counts —
 * otherwise the very failure limb 1 looks for would read as a push.
 */
class WatchingClient extends NebulaClient {
  watched = '';
  pushes = 0;

  override handleResourceUpdate(resourceType: string, resourceId: string, result: any): void {
    if (resourceId === this.watched && !(result instanceof Error)) this.pushes += 1;
    return super.handleResourceUpdate(resourceType, resourceId, result);
  }
}

/**
 * ⚠️ **An override is a NEW function, and the mark lives on the function value — so it does not
 * inherit.** Production spells the decorator `@mesh()`; this file runs under `tsx`, which does not
 * transform TC39 decorators, so it sets the same flag the decorator sets. Without it the host node's
 * push is refused at the client and the subscription's snapshot never arrives.
 */
(WatchingClient.prototype.handleResourceUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;

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
    console.log(`[current-ontology] ${name} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tab<C extends NebulaClient> {
  client: C;
  close: () => void;
}

export async function run(stack: DevStack): Promise<void> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  const galaxy = `${testSlug('cur')}.app`;
  const tenant = `${galaxy}.tenant`;
  const dev = `${galaxy}.dev`; // every Galaxy is born with its `.dev` Star

  // One real login. It claims the universe, so its admin reaches both Stars beneath the Galaxy;
  // the `.dev` token is an ordinary refresh at that scope, as a Studio tab does.
  const loginBrowser = new Browser();
  const provisioned = await step('login + provision', 90_000, () => provisionAndLogin({
    baseUrl: origin, scope: tenant, testToken: readDevVar('TEST_TOKEN'), fetchImpl: loginBrowser.fetch,
  }));
  const tenantSession = { accessToken: provisioned.accessToken, sub: provisioned.sub };
  const devSession = await step('token at .dev', 30_000,
    () => refreshAccessToken(origin, provisioned.session, dev, loginBrowser.fetch));

  const tabs: Array<Tab<NebulaClient>> = [];
  const disposers: Array<() => void> = [];
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} ${detail}`);
  };

  /** A tab pinned to `version` on `scope` — the version a built app carries in its bundle. */
  const openTab = async <C extends NebulaClient>(
    scope: string, session: { accessToken: string; sub: string }, version: string,
    Ctor: new (config: ConstructorParameters<typeof NebulaClient>[0]) => C,
  ): Promise<Tab<C>> => {
    const browser = new Browser();
    const ctx = browser.context(scopeUrlOf(stack, scope));
    const client = new Ctor({
      baseUrl: scopeUrlOf(stack, scope),
      platformOrigin: origin,
      ontologyVersion: version,
      resourceHostBinding: 'STAR',
      accessToken: session.accessToken,
      instanceName: `${session.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    const deadline = Date.now() + 30_000;
    while (client.connectionState !== 'connected') {
      assert.ok(Date.now() < deadline, `a tab on ${scope} never reached connected (state=${client.connectionState})`);
      await sleep(50);
    }
    const tab: Tab<C> = {
      client,
      close: () => { try { client[Symbol.dispose](); } catch { /* already disposed */ } ctx.close(); },
    };
    tabs.push(tab);
    return tab;
  };

  /**
   * Create one resource, retrying while the Star installs. The first op a Star sees for a version
   * it lacks answers `installing` while its pull is in flight, and the client's own retries are
   * shorter than a pull can take — so this waits, but only on that answer. A rejection or a
   * conflict is final and returns at once.
   */
  const create = async (
    tab: Tab<NebulaClient>, typeName: string, value: Record<string, unknown>,
    waitMs = 30_000, id: string = crypto.randomUUID(),
  ): Promise<string> => {
    const deadline = Date.now() + waitMs;
    let last = '';
    while (Date.now() < deadline) {
      const outcome = await tab.client.resources.transaction({
        [id]: { op: 'create', typeName, nodeId: ROOT_NODE_ID, value },
      });
      last = outcome.kind;
      if (last === 'committed' || last === 'rejected' || last === 'conflict') return last;
      await sleep(500);
    }
    return last;
  };

  // The app is new, so on a deployed target its host answers once its certificate is issued; its
  // wildcard covers the tenant and `.dev` hosts every connection below dials.
  await step("the app's host answers", NEW_HOST_TIMEOUT_MS, () => waitForHost(scopeUrlOf(stack, galaxy)));
  const admin = await step('admin connects', 45_000, () => connectDriver(stack, { scope: tenant, session: tenantSession }));
  disposers.push(() => admin.dispose());
  // The galaxy's source and Apply are asked from Studio, its own page, where the universe admin
  // holds dominion over it (the host rule); the tenant page's driver stays for the Stars.
  const studio = await step('studio connects', 45_000, async () => connectDriver(stack, {
    scope: galaxy, session: await refreshAccessToken(origin, provisioned.session, galaxy, loginBrowser.fetch),
  }));
  disposers.push(() => studio.dispose());
  const galaxyCall = <T>(chain: unknown, timeoutMs = 30_000): Promise<T> =>
    studio.client.lmz.callAsync('GALAXY', galaxy, chain as any, { timeoutMs }) as Promise<T>;

  try {
    // ── v1: the seed ontology, applied, and installed on both Stars ─────────────────────────
    const seed = await step('read the seed ontology', 30_000,
      () => galaxyCall<string>(studio.client.ctn<Galaxy>().readSource('src/ontology.d.ts')));
    assert.match(seed, /interface Item\b/, 'the seed ontology has no Item type — every write below assumes one');
    const { version: v1 } = await step('apply v1', 240_000,
      () => galaxyCall<{ version: string }>(studio.client.ctn<Galaxy>().applyOntology(), 240_000));

    const tenantOld = await step('v1 tab on the tenant', 45_000,
      () => openTab(tenant, tenantSession, v1, NebulaClient));
    const devOld = await step('v1 tab on .dev', 45_000, () => openTab(dev, devSession, v1, NebulaClient));
    const xId = crypto.randomUUID();
    const seeded = await step('tenant installs v1', 45_000,
      () => create(tenantOld, 'Item', { title: 'x-0' }, 30_000, xId));
    assert.equal(seeded, 'committed', `the tenant Star never installed v1 (last outcome: ${seeded})`);
    const devSeeded = await step('.dev installs v1', 45_000, () => create(devOld, 'Item', { title: 'dev-0' }));
    assert.equal(devSeeded, 'committed', `the .dev Star never installed v1 (last outcome: ${devSeeded})`);

    // ── v2: adds a type, applied, and installed on both Stars ──────────────────────────────
    await step('write v2', 30_000,
      () => galaxyCall(studio.client.ctn<Galaxy>().writeSource('src/ontology.d.ts', seed + TAG_TYPE)));
    const { version: v2 } = await step('apply v2', 240_000,
      () => galaxyCall<{ version: string }>(studio.client.ctn<Galaxy>().applyOntology(), 240_000));
    assert.notEqual(v2, v1, 'the edit to the ontology did not produce a new version');

    const writer = await step('v2 writer on the tenant', 45_000,
      () => openTab(tenant, tenantSession, v2, NebulaClient));
    const watcher = await step('v2 watcher on the tenant', 45_000,
      () => openTab(tenant, tenantSession, v2, WatchingClient));
    const tenantMoved = await step('tenant installs v2', 45_000,
      () => create(writer, 'Tag', { label: 'moves the tenant to v2' }));
    assert.equal(tenantMoved, 'committed', `the tenant Star never installed v2 (last outcome: ${tenantMoved})`);
    const devNew = await step('v2 tab on .dev', 45_000, () => openTab(dev, devSession, v2, NebulaClient));
    const devMoved = await step('.dev installs v2', 45_000,
      () => create(devNew, 'Tag', { label: 'moves .dev to v2' }));
    assert.equal(devMoved, 'committed', `the .dev Star never installed v2 (last outcome: ${devMoved})`);

    // The writer subscribes too, so its `put` eTags auto-derive; the watcher is the one measured.
    watcher.client.watched = xId;
    const watchSub = watcher.client.resources.subscribe('Item', xId);
    const writeSub = writer.client.resources.subscribe('Item', xId);
    disposers.push(() => watchSub[Symbol.dispose](), () => writeSub[Symbol.dispose]());
    await step('v2 tabs subscribed', 30_000, () => Promise.all([watchSub.snapshot, writeSub.snapshot]));

    let bumps = 0;
    /** Rename x from the writer, then report whether the watcher heard it. */
    const bumpAndSee = async (): Promise<{ outcome: string; heard: boolean }> => {
      const before = watcher.client.pushes;
      bumps += 1;
      let outcome: string;
      try {
        outcome = (await step(`rename #${bumps}`, 30_000, () => writer.client.resources.transaction({
          [xId]: { op: 'put', typeName: 'Item', value: { title: `x-${bumps}` } } as any,
        }))).kind;
      } catch (err) {
        outcome = `threw: ${(err instanceof Error ? err.message : String(err)).slice(0, 70)}`;
      }
      const deadline = Date.now() + PUSH_TIMEOUT_MS;
      while (watcher.client.pushes <= before && Date.now() < deadline) await sleep(150);
      return { outcome, heard: watcher.client.pushes > before };
    };

    // ── LIMB 1: a stale tab cannot move the tenant Star off v2 ─────────────────────────────
    //    Positive control first: with no stale tab in play, the watcher hears a write — so its
    //    silence afterwards means its subscription was dropped, not that it was never live.
    const control = await bumpAndSee();
    assert.ok(control.outcome === 'committed' && control.heard,
      `before any stale request the watcher must hear a write (write ${control.outcome}, heard ${control.heard}) — ` +
      'otherwise limb 1 measures nothing');

    let staleAnswer: string;
    try {
      await step('the v1 tab reads', 30_000, () => tenantOld.client.resources.read('Item', xId));
      staleAnswer = 'served';
    } catch (err) {
      staleAnswer = (err as Error)?.name ?? String(err);
    }
    await sleep(1_000); // let any install the stale request set off land before measuring
    const after = await bumpAndSee();
    const tagAfter = await step('a v2-only type, after', 45_000,
      () => create(writer, 'Tag', { label: 'still v2' }, 5_000));
    record('a stale tab cannot move the Star off the current version',
      staleAnswer === 'OntologyStaleError' && after.outcome === 'committed' && after.heard && tagAfter === 'committed',
      `the v1 tab was answered ${staleAnswer}; afterwards the watcher ${after.heard ? 'still heard the next write' : 'HEARD NOTHING — its subscription was dropped'} (write ${after.outcome}), and a v2-only Tag was ${tagAfter}`);

    // ── LIMB 2: a reverted ontology is served on a Star that already moved past it ─────────
    //    Setup control: writing v1's exact bytes back must make v1 current again, or this limb
    //    measures something other than a revert.
    await step('revert the file to v1', 30_000,
      () => galaxyCall(studio.client.ctn<Galaxy>().writeSource('src/ontology.d.ts', seed)));
    const current = await step('read current', 30_000,
      () => galaxyCall<{ version: string } | null>(studio.client.ctn<Galaxy>().getCurrentOntology()));
    assert.equal(current?.version, v1, 'writing v1 back did not make v1 current — nothing below measures a revert');
    const devBack = await step('v1 tab on .dev, after the revert', 45_000,
      () => openTab(dev, devSession, v1, NebulaClient));
    const reverted = await step('the v1 tab writes', 45_000,
      () => create(devBack, 'Item', { title: 'served after the revert' }, 20_000));
    record('a reverted ontology is served on a Star that already moved past it',
      reverted === 'committed',
      reverted === 'committed'
        ? 'a v1 tab on the .dev Star committed once v1 was current again'
        : `a v1 tab on the .dev Star never committed (last outcome: ${reverted})`);

    const open = results.filter((r) => !r.ok);
    assert.equal(open.length, 0,
      `${open.length} of ${results.length} current-ontology properties do not hold:\n` +
      open.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'));
  } finally {
    for (const d of disposers) { try { d(); } catch { /* already released */ } }
    for (const t of tabs) t.close();
  }
}
