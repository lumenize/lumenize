/**
 * Phase-1 acceptance scenario — the "verify the chat-history *mechanism* in a running system"
 * round-trip (`tasks/archive/claude-live-verification.md`).
 *
 * Capable-of-failing (asserts, does not print): post a `Session` + `Message` carrying a known
 * marker into claude@'s fresh sandbox in ONE atomic transaction, then **read AND subscribe it
 * back** and assert the marker is present. Then the NEGATIVE CONTROL — a base-shape token (flat
 * `scopeAdmin`, no `access`) and a nebula-shaped-but-no-`access` token are both REJECTED at the
 * gateway for the same read — proving the admin-promotion token is the *right* shape, not
 * merely that "something read".
 *
 * All `client.resources.*` — the public mesh CLIENT surface (never raw stub RPC / DO-internal
 * access); `callAsync` under the covers is the only awaitable (mesh.md bright line).
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { Snapshot } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, mintDegradedToken, assertTokenRejected } from '../lib/harness';

/** Star-tier sandbox under the `claude` Universe; `.dev` star slug so `resetDevData` accepts it. */
export const SCOPE = 'claude.sandbox';

export async function run(stack: DevStack): Promise<void> {
  const marker = `harness-marker-${crypto.randomUUID()}`;
  const driver = await connectDriver(stack, { scope: SCOPE });

  try {
    // ── POSITIVE: create Session + Message (ADR-006 by-id FK, client UUIDs) atomically ──
    const sessionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
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

    // ── ATTRIBUTION rides the read-back (ADR-016 record → wire projection): the server stamped the
    // writer's identity from the VERIFIED token — subject `sub` + display `profileId` — and the
    // asserted `access` never leaves the DO. Real-login claims (rung 1), so the `profileId` here is
    // the one the registry actually minted for this fresh address — no fixture to build wrong.
    // (Each assert is backed by an in-lane mutation: narrowed projection reds the profileId limb;
    // wire pass-through reds the access limb — mint-narrower-token-payoff / star-resources.)
    {
      const at = readBack.meta.actingToken;
      const claims = driver.client.claims;
      assert.ok(claims.profileId, 'fixture guard: a real login must carry a profileId claim, or the equality below is vacuous');
      assert.equal(at.sub, claims.sub, 'actingToken.sub must be the logged-in writer');
      assert.equal(at.profileId, claims.profileId,
        'actingToken.profileId must ride for display (the ADR-013 write-time stamp)');
      assert.ok(!('access' in at), 'the asserted access must NOT ride a client-bound snapshot');
    }

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
    // (a) nebula-shaped but NO `access` claim → isolates access.authScope as the sole
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
