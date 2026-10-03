/**
 * **What a deletion removes on Cloudflare: an app's certificate pack, and its Durable Objects'
 * storage.** Both are read from Cloudflare's own API, never from the Worker, so a teardown that
 * reported success while leaving either behind still reds.
 *
 *  1. **An app deleted at once after its create leaves no pack naming its host**, read after waiting
 *     past the alarm, while its order may still have been in flight. A deleted active pack stays
 *     listed as `pending_deletion` for ten minutes and more, so a pack on its way out counts as
 *     gone. *Reds if teardown skips the pack delete.*
 *  2. **So does an app whose create and delete are fired together.** The delete can land before the
 *     wake, which is the reap's case.
 *  3. **The account's first app keeps its pack, and the zone keeps its Universal pack, after each
 *     delete** — the positive control: a teardown matching any host in a pack would delete both.
 *  4. **A deleted app's Galaxy holds no stored data.** Node cannot compute `idFromName`, so the
 *     scenario tails the Worker while it creates the app and reads the Galaxy's id off the event that
 *     logs its own creation teardown. The `.dev` Star holds nothing after that teardown, so Cloudflare
 *     never lists it with data and there is nothing of it to see go; it runs the same `teardown`.
 *     Cloudflare's object listing trails the objects by six to eight minutes (measured 2026-10-03), so
 *     the limb waits for the Galaxy to be listed holding data — the positive control — before it
 *     deletes, and for it to be listed without data after. The tail also shows the deletion's
 *     teardown of each object reading the abort's rejection as the reset it ordered, never as a
 *     failure. *Reds if teardown skips `deleteAll()`, or counts the abort's rejection a failure.*
 *     Dropping the macrotask yield before `ctx.abort()` did not red it on 2026-10-03. Slow by
 *     design: about a quarter of an hour, the listing's lag twice.
 *  5. **The account deleted with two apps leaves neither pack listed.**
 *
 * Deployed only. A local stack's `http` origin orders no pack, and miniflare's abort wipes storage
 * by itself, so locally nothing here can red; `scope-teardown` covers the deletion's in-Worker
 * half in both venues. It reads the test zone with `TEST_CERTIFICATE_API_TOKEN`, the account's
 * Durable Objects with `CLOUDFLARE_WORKERS_READ_TOKEN`, both from `.dev.vars`, and the Worker's
 * events with `wrangler tail`, on the local `wrangler login` session.
 *
 * `needsContainer = false` — nothing here builds.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packNamesGalaxy, cloudflareCertificateApi } from '../../src/certificate';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
// @ts-expect-error — plain JS with JSDoc types (no build in dev, workflow.md); shared with deploy-test.sh.
import { TEST_ORIGIN } from '../../scripts/test-deploy-config.mjs';

export const needsContainer = false;

/** Long enough for a wake's alarm to fire and its order to land: an order is the alarm's first act. */
const PAST_THE_ALARM_MS = 45_000;
/** How long a deleted pack may take to leave the live listing, past the alarm. */
const PACK_DELETE_MS = 3 * 60_000;
/** Statuses of a pack on its way out: a deleted active pack stays listed `pending_deletion` for
 *  ten minutes and more (2026-10-03), so it counts as gone. */
const DELETING = new Set(['pending_deletion', 'deleted']);
/** How long Cloudflare's object listing may trail what happened: twice the lag measured. */
const LISTING_LAG_MS = 16 * 60_000;
const WORKER = process.env.TEST_WORKER_NAME ?? 'test-nebula';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One of our `@lumenize/debug` lines, as the tail carries it. */
interface TailLine { namespace?: string; message?: string; level?: string; data?: Record<string, unknown> }

/** The account's Durable Objects of one class on the test Worker: each object's id, and whether it holds data. */
function durableObjects(): (className: string) => Promise<Map<string, boolean>> {
  const token = readDevVar('CLOUDFLARE_WORKERS_READ_TOKEN');
  const account = readDevVar('CLOUDFLARE_ACCOUNT_ID');
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces`;
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${url.replace(account, '{account}')} answered ${res.status}`);
    return await res.json() as { result: Array<Record<string, unknown>>; result_info?: { cursor?: string } };
  };
  const namespaces = new Map<string, string>();
  return async (className) => {
    if (namespaces.size === 0) {
      for (const n of (await get(`${api}?per_page=1000`)).result) {
        if (n.script === WORKER) namespaces.set(n.class as string, n.id as string);
      }
    }
    const ns = namespaces.get(className);
    if (!ns) throw new Error(`${WORKER} has no ${className} namespace`);
    const objects = new Map<string, boolean>();
    for (let cursor: string | undefined, page = 0; page < 100; page++) {
      const body = await get(`${api}/${ns}/objects?limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      for (const o of body.result) objects.set(o.id as string, Boolean(o.hasStoredData));
      cursor = body.result_info?.cursor;
      if (!cursor || body.result.length === 0) break;
    }
    return objects;
  };
}

/**
 * `wrangler tail` on the test Worker, mapping each Durable Object's `instanceName`, as its own log
 * lines name it, to the `durableObjectId` the event carries. In JSON mode the tail prints nothing
 * until an event arrives, so it is live once a request `ping` makes has come back through it.
 */
async function tailObjectIds(ping: () => Promise<unknown>): Promise<{
  idOf: (instanceName: string) => string | undefined; lines: TailLine[]; stop: () => void;
}> {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const child = spawn('npx', ['wrangler', 'tail', WORKER, '--format', 'json'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const ids = new Map<string, string>();
  const lines: TailLine[] = [];
  let live = false;
  let pending = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk;
    // Each event is pretty-printed, and its closing brace is the only line that is `}` alone.
    for (let end = pending.indexOf('\n}\n'); end >= 0; end = pending.indexOf('\n}\n')) {
      const text = pending.slice(0, end + 2);
      pending = pending.slice(end + 3);
      let event: { durableObjectId?: string; logs?: Array<{ message?: unknown[] }> };
      try { event = JSON.parse(text.slice(text.indexOf('{'))); } catch { continue; }
      live = true;
      for (const log of event.logs ?? []) {
        try {
          const line = JSON.parse(String(log.message?.[0])) as TailLine;
          lines.push(line);
          // Only an object's own teardown line, which names that object and runs in its own event.
          if (event.durableObjectId && line.namespace === 'nebula.scope.teardown' && line.message === 'tearing down'
            && typeof line.data?.instanceName === 'string') ids.set(line.data.instanceName, event.durableObjectId);
        } catch { /* not one of our JSON lines */ }
      }
    }
  });
  for (const t = Date.now(); !live; await sleep(2_000)) {
    if (Date.now() - t > 90_000) { child.kill(); throw new Error(`wrangler tail ${WORKER} never showed an event`); }
    await ping().catch(() => undefined);
  }
  return { idOf: (name) => ids.get(name), lines, stop: () => child.kill() };
}

export async function run(stack: DevStack): Promise<void> {
  if (!process.env.HARNESS_TARGET_URL) {
    console.error('[deleted-on-cloudflare] not observable on a local stack: its http origin orders no pack, '
      + "and miniflare's abort wipes storage by itself");
    return;
  }
  const origin = stack.baseUrl.replace(/\/$/, '');
  const zoneHost = new URL(TEST_ORIGIN).hostname;
  const certificates = cloudflareCertificateApi(readDevVar('TEST_CERTIFICATE_ZONE_ID'), readDevVar('TEST_CERTIFICATE_API_TOKEN'));
  const hostOf = (galaxy: string) => new URL(scopeUrlOf(stack, galaxy)).hostname;
  const packsNaming = async (galaxy: string) =>
    (await certificates.list()).filter((p) => !DELETING.has(p.status) && packNamesGalaxy(p.hosts, hostOf(galaxy)));
  const objectsOf = durableObjects();
  /** What still names `galaxy`'s host once Cloudflare has had time to drop its deleted packs. */
  const packsLeft = async (galaxy: string) => {
    for (const t = Date.now(); ; await sleep(15_000)) {
      const left = await packsNaming(galaxy);
      if (left.length === 0 || Date.now() - t > PACK_DELETE_MS) return left.map((p) => `${p.status} ${p.hosts.join(' ')}`);
    }
  };

  const universe = testSlug('doc');
  const first = `${universe}.first`; // the claim's first app
  const kept = `${universe}.kept`; // limb 4's app, deleted once the listing has caught up
  const tail = await tailObjectIds(async () => (await fetch(`${origin}/_version`)).body?.cancel());
  let driver: Driver | undefined;
  try {
    // Claimed and signed in through the driver's own cookie jar, so its token renews: the limb-4
    // waits outlast an access token, and a handed token would leave the driver nothing to renew from.
    driver = await connectDriver(stack, { scope: universe });
    const scopes = driver.client.scopes;

    // The positive control's precondition: the claim's acceptance ordered the first app's pack.
    for (let t = Date.now(); (await packsNaming(first)).length === 0; await sleep(5_000)) {
      if (Date.now() - t > 120_000) throw new Error(`no pack ever named ${hostOf(first)}: the claim ordered none`);
    }
    const controls = async (after: string) => {
      // Live packs only: a pack a wrong teardown deleted stays listed `pending_deletion` for minutes.
      const packs = (await certificates.list()).filter((p) => !DELETING.has(p.status));
      assert.ok(packs.some((p) => packNamesGalaxy(p.hosts, hostOf(first))),
        `after ${after}, the first app's pack must still be listed`);
      assert.ok(packs.some((p) => p.hosts.includes(`*.${zoneHost}`) && p.hosts.includes(zoneHost)),
        `after ${after}, the zone's Universal pack must still be listed`);
    };

    // Limb 4's app, created first so the listing's lag runs while the pack limbs do. Its creation
    // teardown logs each object's name, which is where the tail learns their ids.
    assert.deepEqual(await scopes.createGalaxy(universe, 'kept'), { instanceName: kept });
    let keptIds: { galaxy: string } | undefined;
    for (const t = Date.now(); !keptIds; await sleep(1_000)) {
      const galaxy = tail.idOf(kept);
      if (galaxy) keptIds = { galaxy };
      else if (Date.now() - t > 150_000) {
        const named = [...new Set(tail.lines.map((l) => l.data?.instanceName).filter((n) => typeof n === 'string'))];
        throw new Error(`the tail never named ${kept}'s Galaxy; it named ${named.join(', ')}`);
      }
    }

    // ── 1. Created, then deleted at once ────────────────────────────────────────────────────────
    assert.deepEqual(await scopes.createGalaxy(universe, 'gone'), { instanceName: `${universe}.gone` });
    await scopes.delete(`${universe}.gone`);
    await sleep(PAST_THE_ALARM_MS);
    assert.deepEqual(await packsLeft(`${universe}.gone`), [], 'an app deleted at once after its create must leave no pack naming its host');
    await controls('the first delete');
    console.error('  ✓ limb 1 — an app deleted at once after its create left no pack');

    // ── 2. Created and deleted together ─────────────────────────────────────────────────────────
    const raced = `${universe}.raced`;
    const [createdRaced] = await Promise.allSettled([scopes.createGalaxy(universe, 'raced'), scopes.delete(raced)]);
    assert.deepEqual(createdRaced.status === 'fulfilled' ? createdRaced.value : createdRaced.reason?.message, { instanceName: raced },
      'the raced create must land, or there was no pack to leave');
    // Whichever landed first, end with the app deleted: a delete that found nothing is retried.
    await scopes.delete(raced).catch(() => undefined);
    await sleep(PAST_THE_ALARM_MS);
    assert.deepEqual(await packsLeft(raced), [], 'an app created and deleted together must leave no pack naming its host');
    await controls('the raced delete');
    console.error('  ✓ limb 2 — an app created and deleted together left no pack');
    console.error("  ✓ limb 3 — the first app's pack and the Universal pack stayed after each delete");

    // ── 4. The deleted app's Durable Objects hold no stored data ────────────────────────────────
    const listed = async () => ({ galaxy: await objectsOf('Galaxy') });
    for (const t = Date.now(); (await listed()).galaxy.get(keptIds.galaxy) !== true; await sleep(30_000)) {
      if (Date.now() - t > LISTING_LAG_MS) throw new Error(`Cloudflare never listed ${kept}'s Galaxy holding data`);
    }
    await scopes.delete(kept);
    // The deletion's own teardown of each object: the abort's rejection, as Cloudflare delivers it,
    // must read as the reset the teardown ordered, never as a failure.
    const teardownOf = (name: string, message: string) => tail.lines.some((l) => l.namespace === 'nebula.scope.teardown'
      && l.message === message && l.data?.instanceName === name && l.data?.cause === 'deletion');
    for (const t = Date.now(); ![kept, `${kept}.dev`].every((n) => teardownOf(n, 'reset as ordered')); await sleep(1_000)) {
      if (Date.now() - t > 60_000) throw new Error(`the tail never showed ${kept}'s objects reset as ordered`);
    }
    assert.deepEqual([kept, `${kept}.dev`].filter((n) => teardownOf(n, 'teardown failed')), [],
      'the deletion must log no teardown failure');
    let stored: string[] = [];
    for (const t = Date.now(); ; await sleep(30_000)) {
      const now = await listed();
      stored = now.galaxy.get(keptIds.galaxy) ? [`Galaxy ${keptIds.galaxy}`] : [];
      if (stored.length === 0 || Date.now() - t > LISTING_LAG_MS) break;
    }
    assert.deepEqual(stored, [], "a deleted app's Durable Objects must hold no stored data");
    console.error(`  ✓ limb 4 — ${kept}'s Galaxy, listed holding data before the delete, holds none after; it and its .dev Star reset as ordered`);

    // ── 5. The account, with two apps ───────────────────────────────────────────────────────────
    assert.deepEqual(await scopes.createGalaxy(universe, 'second'), { instanceName: `${universe}.second` });
    for (let t = Date.now(); (await packsNaming(`${universe}.second`)).length === 0; await sleep(5_000)) {
      if (Date.now() - t > 120_000) throw new Error(`no pack ever named ${hostOf(`${universe}.second`)}`);
    }
    await scopes.delete(universe);
    await sleep(PAST_THE_ALARM_MS);
    for (const app of [first, `${universe}.second`]) {
      assert.deepEqual(await packsLeft(app), [], `deleting the account must delete ${app}'s pack`);
    }
    assert.ok((await certificates.list()).some((p) => !DELETING.has(p.status) && p.hosts.includes(`*.${zoneHost}`)), 'the Universal pack must stay');
    console.error('  ✓ limb 5 — the account deleted with two apps left neither pack');
  } finally {
    tail.stop();
    driver?.dispose();
  }
}
