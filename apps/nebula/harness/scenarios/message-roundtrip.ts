/**
 * Phase-1 acceptance scenario — the "verify the chat-history *mechanism* in a running system"
 * round-trip (`tasks/archive/claude-live-verification.md`).
 *
 * Capable-of-failing (asserts, does not print): post a `Session` + `Message` carrying a known
 * marker into claude@'s fresh sandbox in ONE atomic transaction, then **read AND subscribe it
 * back** and assert the marker is present. Then the NEGATIVE CONTROL — a base-shape token (flat
 * `isAdmin`, no `access`) and a nebula-shaped-but-no-`access` token are both REJECTED at the
 * gateway for the same read — proving the founder-promotion token is the *right* shape, not
 * merely that "something read".
 *
 * All `client.resources.*` — the public mesh CLIENT surface (never raw stub RPC / DO-internal
 * access); `callAsync` under the covers is the only awaitable (mesh.md bright line).
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { Snapshot } from '@lumenize/nebula/client';
import { generateUuid } from '@lumenize/auth/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, mintDegradedToken, assertTokenRejected } from '../lib/harness';

/** Star-tier sandbox under the `claude` Universe; `.dev` star slug so `resetDevData` accepts it. */
export const SCOPE = 'claude.sandbox.dev';

export async function run(stack: DevStack): Promise<void> {
  const marker = `harness-marker-${generateUuid()}`;
  const driver = await connectDriver(stack, { scope: SCOPE });

  try {
    // ── POSITIVE: create Session + Message (ADR-006 by-id FK, client UUIDs) atomically ──
    const sessionId = generateUuid();
    const messageId = generateUuid();
    const out = await driver.client.resources.transaction({
      [sessionId]: { op: 'create', typeName: 'Session', nodeId: ROOT_NODE_ID, value: { title: 'harness chat' } },
      [messageId]: {
        op: 'create',
        typeName: 'Message',
        nodeId: ROOT_NODE_ID,
        value: { session: sessionId, role: 'user', content: marker },
      },
    });
    assert.equal(out.kind, 'committed', `transaction should commit, got kind=${out.kind}`);

    // ── READ it back: the marker persisted ──
    const readBack = (await driver.client.resources.read('Message', messageId)) as Snapshot;
    assert.equal(
      (readBack.value as { content: string }).content,
      marker,
      'read-back Message.content must equal the posted marker (persist → read)',
    );
    assert.equal(
      (readBack.value as { session: string }).session,
      sessionId,
      'read-back Message.session must equal the FK (ADR-006 by-id relationship preserved)',
    );

    // ── SUBSCRIBE it back: the marker also arrives on the live subscription's initial snapshot ──
    {
      using sub = driver.client.resources.subscribe('Message', messageId);
      const snap = await sub.snapshot;
      assert.ok(snap, 'subscribe should deliver an initial snapshot for the created Message');
      assert.equal(
        (snap!.value as { content: string }).content,
        marker,
        'subscribed Message.content must equal the posted marker (persist → subscribe push)',
      );
    }

    // ── NEGATIVE CONTROL: wrong-shape tokens are rejected at the gateway for the same read ──
    // (a) nebula-shaped but NO `access` claim → isolates access.authScopePattern as the sole
    //     discriminator (the strongest control); (b) the literal base mesh/auth shape.
    await assertTokenRejected(stack, {
      scope: SCOPE,
      token: await mintDegradedToken(stack, { scope: SCOPE, kind: 'no-access' }),
    });
    await assertTokenRejected(stack, {
      scope: SCOPE,
      token: await mintDegradedToken(stack, { scope: SCOPE, kind: 'base' }),
    });

    // ── WIPE (best-effort; the deterministic local reset is the fresh boot) ──
    driver.wipe();
  } finally {
    driver.dispose();
  }
}
