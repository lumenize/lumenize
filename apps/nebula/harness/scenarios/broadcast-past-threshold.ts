/**
 * A fan-out WIDER than `svc.broadcast`'s direct-vs-tree cutoff still reaches every subscriber.
 *
 * `svc.broadcast` (`packages/mesh/src/broadcast.ts`) dispatches a flat loop while
 * `targets.length <= directThreshold` and hands the list to a recursive tier Worker above it.
 * The framework default is 100. The tier is reached over a service binding named
 * `LUMENIZE_BROADCAST_TIER`, and `lmz.call` validates its target synchronously — so on a Worker
 * that does not bind one, the 101st subscriber does not degrade, it THROWS.
 *
 * Nebula does not bind a tier. It pins the flat loop instead (`NebulaDO.broadcast`), which is a
 * deliberate, dated interim: the loop's tail latency grows with N (measured ~1.7 s to the last of
 * 1,000 subscribers, deployed) where the tier's does not, and lag is the signal we would rather
 * field than a cliff. `docs/adr/018` is not what governs this — it is a placement question the
 * `NebulaDO.broadcast` JSDoc carries.
 *
 * ⚠️ **This is the only test at any tier that puts more than `directThreshold` subscribers on one
 * query.** Every vitest fan-out test runs two clients, so the whole branch is invisible to them —
 * which is how a Worker with no tier binding stayed green for three months.
 *
 * **Capable of failing**: reds on `main` before the pin (the broadcast throws for want of the tier
 * binding, so no subscriber past the threshold is pushed to), and the baseline limb below reds if
 * the subscriptions were never live in the first place.
 *
 * **One login, many tabs — not a fixture.** All the subscribers are one real person
 * (ADR-009 rung 1) on many connections, which is what the Gateway's own instance-name rule
 * describes: the verified `sub` leads and everything after the first `.` is free
 * (`.claude/rules/mesh.md`). `connectDriver` already mints exactly that per driver. The server
 * decides every claim here; nothing about the fan-out is constructed on this side.
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { QuerySubscription } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';

export const needsContainer = false;

/** A galaxy-tier scope: two segments, so resources host on the GALAXY (`constructionPairs`). */
const SCOPE = 'claude-bcast.app';

/**
 * Comfortably past the framework's default `directThreshold` of 100, with margin for the
 * originator being excluded from its own push. Every one of these is a real WebSocket on its own
 * Gateway DO, so the count is also what makes the boot worth its seconds — a smaller number would
 * exercise the flat loop the two-client vitest tests already cover.
 */
const SUBSCRIBER_COUNT = 120;

/** Connect this many at once. Serial is needlessly slow; unbounded floods the local stack. */
const CONNECT_BATCH = 12;

/** A push crosses one process boundary; anything beyond this is a failure, not slowness. */
const DELIVERY_TIMEOUT_MS = 60_000;

export async function run(stack: DevStack): Promise<void> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  const testToken = readDevVar('TEST_TOKEN');
  const drivers: Driver[] = [];
  const handles: QuerySubscription[] = [];

  // ── ONE real email login; every connection below rides the token the server minted ──
  const { accessToken, sub } = await provisionAndLogin({
    baseUrl: origin, scope: SCOPE, testToken,
  });
  const session = { accessToken, sub };

  try {
    const originator = await connectDriver(stack, { scope: SCOPE, session });
    drivers.push(originator);

    // ── A chat with one message in it, so the query below has a membership to start from ──
    const chatId = crypto.randomUUID();
    const seedMessageId = crypto.randomUUID();
    const seeded = await originator.client.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'broadcast width' } },
      [seedMessageId]: {
        op: 'create', typeName: 'Message', nodeId: ROOT_NODE_ID,
        value: { chat: chatId, content: 'seed' },
      },
    });
    assert.equal(seeded.kind, 'committed', `seed transaction should commit, got kind=${seeded.kind}`);

    const chatQuery = {
      queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: chatId,
    };

    // ── SUBSCRIBERS: one person, many tabs, each its own Gateway DO ──
    for (let i = 0; i < SUBSCRIBER_COUNT; i += CONNECT_BATCH) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(CONNECT_BATCH, SUBSCRIBER_COUNT - i) }, () =>
          connectDriver(stack, { scope: SCOPE, session })),
      );
      drivers.push(...batch);
    }
    const subscribers = drivers.slice(1);
    assert.equal(subscribers.length, SUBSCRIBER_COUNT, 'every subscriber connection must be up');

    for (const d of subscribers) handles.push(d.client.resources.subscribeQuery(chatQuery));
    await Promise.all(handles.map((h) => h.ready));

    // ── POSITIVE CONTROL: the subscriptions are live and the query is the right one. Without
    //    this limb, the delivery assert below could pass vacuously on a query nobody is on.
    const baselineMisses = handles.filter((h) => !h.resourceIds.includes(seedMessageId)).length;
    assert.equal(baselineMisses, 0,
      `all ${SUBSCRIBER_COUNT} subscribers must start holding the seed message; ${baselineMisses} did not`);
    assert.ok(subscribers.length > 100,
      `fixture guard: ${subscribers.length} subscribers does not cross the framework default of 100, so this scenario cannot see the branch it exists for`);

    // ── THE FAN-OUT UNDER TEST: one commit, pushed to more targets than the direct cutoff ──
    const wideMessageId = crypto.randomUUID();
    const committed = await originator.client.resources.transaction({
      [wideMessageId]: {
        op: 'create', typeName: 'Message', nodeId: ROOT_NODE_ID,
        value: { chat: chatId, content: 'past the threshold' },
      },
    });
    assert.equal(committed.kind, 'committed',
      `the wide-fanout transaction should commit, got kind=${committed.kind} — a broadcast that throws for want of a tier binding can fail the commit that triggered it`);

    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    let arrived = 0;
    for (;;) {
      arrived = handles.filter((h) => h.resourceIds.includes(wideMessageId)).length;
      if (arrived === SUBSCRIBER_COUNT) break;
      assert.ok(Date.now() < deadline,
        `only ${arrived}/${SUBSCRIBER_COUNT} subscribers received the membership push within ${DELIVERY_TIMEOUT_MS / 1000}s — a fan-out past the direct threshold must reach EVERY subscriber (0 arrivals reads as the broadcast throwing; a partial count reads as the tier dropping targets)`);
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(arrived, SUBSCRIBER_COUNT, 'every subscriber received the wide fan-out');
  } finally {
    for (const h of handles) { try { h[Symbol.dispose](); } catch { /* already released */ } }
    for (const d of drivers) d.dispose();
  }
}
