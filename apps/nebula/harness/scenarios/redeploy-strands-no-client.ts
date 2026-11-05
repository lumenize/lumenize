/**
 * **A redeploy strands no Client: after it, a change still reaches every tab on the host.**
 *
 * A page's Client is held by the node its host names. The task that hosted pages there expected a
 * redeploy to restart that node and drop its sockets, so each Client would reconnect to a fresh
 * object and be told to re-subscribe. Measured on 2026-10-07, it does not: two redeploys of
 * `test-nebula`, each a new version, left both tabs' sockets open, since a hibernated host's sockets
 * live in the runtime and the new version picks them up. Whichever happens, what a user feels is
 * whether the next change reaches the page, so that is what this asserts, and it reports what the
 * sockets did. A host reset is `scope-hosts-its-clients` limb 7's: founding a Star resets it, and
 * its tab is told to re-subscribe.
 *
 * One limb. Alice and Dana, two tabs of one login, hold sockets on a tenant Star and watch its
 * tree. The test Worker is redeployed with `npm run deploy:test`, a minute passes for a rollout to
 * drop sockets if it will, and then both tabs are connected and a later change to the tree reaches
 * both. Mutation, deployed: a host that finds a Client's socket only among those it accepted in
 * this isolate, so the redeployed host cannot deliver.
 *
 * Deployed only, and only when asked. A local stack has no redeploy, and a redeploy in the middle of
 * a deployed sweep could reset every other scenario's objects too, so this runs with
 * `HARNESS_REDEPLOY=1` against the test target alone, after the sweep, and reports itself skipped
 * otherwise. It refuses any target but `lumenize-test.dev`, since the command it runs deploys that.
 *
 * A real login (ADR-009 rung 1): the run's shared app's owner. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Browser } from '@lumenize/testing';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Star } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { constructionPairs, readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin, refreshAccessToken } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';

export const needsContainer = false;

/** Parked in every sweep: its redeploy would restart the objects other scenarios are using. */
export const skip = 'run it directly, deployed, with HARNESS_REDEPLOY=1: it redeploys the test Worker';

/** A tab that counts its re-subscribe reports and the tree pushes that reach it. */
class CountingTab extends NebulaClient {
  required = 0;
  treePushes = 0;
  /** Every connection state the tab passed through, so a failure says whether its socket dropped. */
  states: string[] = [];

  override onSubscriptionRequired(): void {
    this.required += 1;
    super.onSubscriptionRequired();
  }

  override handleOrgTreeUpdate(envelope: any): void {
    this.treePushes += 1;
    return super.handleOrgTreeUpdate(envelope);
  }
}

/** `tsx` does not transform TC39 decorators, so the push handler gets the flag `@mesh()` sets. */
(CountingTab.prototype.handleOrgTreeUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;

/** Poll `check` until it holds or `ms` passes; answers whether it held. */
async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
}

export async function run(stack: DevStack): Promise<void> {
  const target = process.env.HARNESS_TARGET_URL;
  if (!target || process.env.HARNESS_REDEPLOY !== '1') {
    console.log('  · skipped: deployed only, with HARNESS_REDEPLOY=1, since it redeploys the test Worker');
    return;
  }
  assert.ok(new URL(target).hostname.endsWith('lumenize-test.dev'),
    `this scenario redeploys the test Worker, and ${target} is not the test target`);

  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const star = `${app.galaxy}.${testSlug('redeploy')}`;
  const owner = await provisionAndLogin({ baseUrl: origin, scope: app.galaxy, email: app.ownerEmail, testToken });
  const onStar = await refreshAccessToken(origin, owner.session, star);

  const tabs: CountingTab[] = [];
  const tab = async (name: string): Promise<CountingTab> => {
    const ctx = new Browser().context(scopeUrlOf(stack, star));
    const t = new CountingTab({
      baseUrl: scopeUrlOf(stack, star),
      platformOrigin: origin,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(star),
      accessToken: onStar.accessToken,
      instanceName: `${onStar.sub}.${name}-${crypto.randomUUID().slice(0, 6)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      onConnectionStateChange: (state) => { t.states.push(state); },
    });
    tabs.push(t);
    assert.ok(await eventually(() => t.connectionState === 'connected', 30_000), `${name}'s tab never connected`);
    await t.lmz.callAsync('STAR', star, t.ctn<Star>().resources.subscribeTree());
    return t;
  };

  try {
    const alice = await tab('alice');
    const dana = await tab('dana');
    const before = [alice.required, dana.required];
    const statesBefore = [alice.states.length, dana.states.length];

    // ── The redeploy: a new version, since every deploy stamps its build time ─────────────────
    const appDir = fileURLToPath(new URL('../..', import.meta.url));
    console.log('  · redeploying the test Worker…');
    const deploy = spawnSync('npm', ['run', 'deploy:test'], { cwd: appDir, stdio: 'inherit', timeout: 15 * 60_000 });
    assert.equal(deploy.status, 0, `npm run deploy:test exited ${deploy.status}`);

    // A minute for a rollout to drop the sockets, if it will, and for each tab to come back.
    await new Promise((r) => setTimeout(r, 60_000));
    for (const [i, [name, t]] of ([['Alice', alice], ['Dana', dana]] as const).entries()) {
      const since = t.states.slice(statesBefore[i]);
      console.log(`  · ${name}'s socket ${since.length === 0 ? 'stayed open' : `went ${JSON.stringify(since)}`}; ` +
        `told to re-subscribe ${t.required - before[i]} time(s)`);
    }
    assert.ok(alice.connectionState === 'connected' && dana.connectionState === 'connected',
      `after the redeploy Alice is ${alice.connectionState} and Dana ${dana.connectionState}`);

    // ── A later push reaches both ───────────────────────────────────────────────────────────
    const pushes = [alice.treePushes, dana.treePushes];
    await alice.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, testSlug('n'), 'After the redeploy');
    assert.ok(await eventually(() => alice.treePushes > pushes[0] && dana.treePushes > pushes[1], 30_000),
      'a change after the redeploy did not reach both tabs');
    console.log('  ✓ a later push reached both tabs');
  } finally {
    for (const t of tabs) { try { t[Symbol.dispose](); } catch { /* already disposed */ } }
  }
}
