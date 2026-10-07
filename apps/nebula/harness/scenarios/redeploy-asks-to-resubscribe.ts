/**
 * **A redeploy resets every host node, and each Client it hosted is told to re-subscribe, once.**
 *
 * A page's Client is held by the node its host names, so a redeploy, which restarts every Durable
 * Object, drops every Client on a node together. Each reconnects to a fresh object that has no
 * record of it, which must say so: the connection reports `subscriptionRequired: true`, and the
 * Client calls `onSubscriptionRequired` once. The subscription rows themselves survive a redeploy,
 * so a later push arrives either way, which is why the limb reds on the report and not on the push.
 *
 * One limb. Alice and Dana, two tabs of one login, hold sockets on a tenant Star and watch its
 * tree. The test Worker is redeployed unchanged, with `npm run deploy:test`. Then: each tab was told
 * to re-subscribe exactly once, and a later change to the tree reaches both. Mutation: have the
 * host node report `subscriptionRequired: false` to a Client it has no record of, deployed.
 *
 * Deployed only, and only when asked. A local stack has no redeploy, and a redeploy in the middle of
 * a deployed sweep would reset every other scenario's objects too, so this runs with
 * `HARNESS_REDEPLOY=1` against the test target alone, after the sweep, and reports itself skipped
 * otherwise. It refuses any target but `lumenize-test.dev`, since the command it runs deploys that.
 *
 * A real login (ADR-009 rung 1): the run's shared app's owner. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Browser } from '@lumenize/testing';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { Star } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { constructionPairs, readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin, refreshAccessToken } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';

export const needsContainer = false;

/** A tab that counts its re-subscribe reports and the tree pushes that reach it. */
class CountingTab extends NebulaClient {
  required = 0;
  treePushes = 0;

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

    // ── The redeploy: unchanged code, every Durable Object restarted ──────────────────────────
    const appDir = fileURLToPath(new URL('../..', import.meta.url));
    console.log('  · redeploying the test Worker, unchanged…');
    const deploy = spawnSync('npm', ['run', 'deploy:test'], { cwd: appDir, stdio: 'inherit', timeout: 15 * 60_000 });
    assert.equal(deploy.status, 0, `npm run deploy:test exited ${deploy.status}`);

    // Each tab drops and reconnects to a fresh Star with no record of it.
    const told = await eventually(() => alice.required > before[0] && dana.required > before[1], 180_000);
    // A rollout that reset the Star twice would report twice: wait long enough to see a second.
    await new Promise((r) => setTimeout(r, 20_000));
    const reports = [alice.required - before[0], dana.required - before[1]];
    assert.ok(told && reports[0] === 1 && reports[1] === 1,
      `after the redeploy Alice was told to re-subscribe ${reports[0]} time(s) and Dana ${reports[1]}, not once each`);
    console.log('  ✓ each tab was told to re-subscribe, once');

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
