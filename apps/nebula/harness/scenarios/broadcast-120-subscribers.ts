/**
 * One commit, pushed to 120 subscribers on one query, reaches every one of them.
 *
 * `lmz.broadcast` (`packages/mesh/src/broadcast.ts`) sends every target from the node that decided
 * to push, one `lmz.call` each, at any N. Its tail latency grows with N, and that is the cost the
 * framework accepts: a fan-out that is slow reaches everybody.
 *
 * ⚠️ **This is the only test at any tier that puts more than a hundred subscribers on one query.**
 * Every vitest fan-out test runs two clients. When the framework handed any list longer than 100 to
 * a tier Nebula never bound, the 101st subscriber threw and failed the commit that triggered it —
 * and nothing below this scenario could see it.
 *
 * ⚠️ **The count stays above a hundred on purpose.** Rebuilding a tier is gated on a real workload
 * past about a hundred subscribers on one query (`tasks/backlog.md` § *Lumenize Mesh*), so a rebuilt
 * tier's cutoff would sit near there, and this scenario is what would see it throw or drop targets.
 *
 * **Capable of failing**: make `broadcast` throw above 100 targets and the commit below fails; the
 * baseline limb reds if the subscriptions were never live in the first place.
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
 * Above the hundred a rebuilt tier's cutoff would sit near (the header says why), with margin for
 * the originator being excluded from its own push. Every one of these is a real WebSocket on its
 * own Gateway DO, so the count is also what makes the boot worth its seconds — a smaller number
 * would exercise the loop the two-client vitest tests already cover.
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
    // Fixture guard, kept as a tripwire: a rebuilt tier's cutoff would sit near a hundred, so a
    // count at or below it would stop this scenario seeing what it is here to see.
    assert.ok(subscribers.length > 100,
      `fixture guard: ${subscribers.length} subscribers is not above 100 — a rebuilt tier's cutoff would sit near there, and this scenario exists to see past it`);

    // ── THE FAN-OUT UNDER TEST: one commit, pushed to every subscriber ──
    const wideMessageId = crypto.randomUUID();
    const committed = await originator.client.resources.transaction({
      [wideMessageId]: {
        op: 'create', typeName: 'Message', nodeId: ROOT_NODE_ID,
        value: { chat: chatId, content: 'to every subscriber' },
      },
    });
    assert.equal(committed.kind, 'committed',
      `the wide-fanout transaction should commit, got kind=${committed.kind} — a broadcast that throws fails the commit that triggered it`);

    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    let arrived = 0;
    for (;;) {
      arrived = handles.filter((h) => h.resourceIds.includes(wideMessageId)).length;
      if (arrived === SUBSCRIBER_COUNT) break;
      assert.ok(Date.now() < deadline,
        `only ${arrived}/${SUBSCRIBER_COUNT} subscribers received the membership push within ${DELIVERY_TIMEOUT_MS / 1000}s — a fan-out must reach EVERY subscriber (0 arrivals reads as the broadcast throwing; a partial count reads as targets dropped)`);
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(arrived, SUBSCRIBER_COUNT, 'every subscriber received the wide fan-out');
  } finally {
    for (const h of handles) { try { h[Symbol.dispose](); } catch { /* already released */ } }
    for (const d of drivers) d.dispose();
  }
}
