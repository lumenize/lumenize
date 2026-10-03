/**
 * Phase-1 acceptance scenario — the "verify the chat-history *mechanism* in a running system"
 * round-trip (`tasks/archive/claude-live-verification.md`).
 *
 * Capable-of-failing (asserts, does not print): post a `Chat` + `Message` carrying a known
 * marker into claude@'s fresh sandbox in ONE atomic transaction, then **read AND subscribe it
 * back** and assert the marker is present. Then the NEGATIVE CONTROL — a base-shape token (flat
 * `scopeAdmin`, no `access`) and a nebula-shaped-but-no-`access` token are both REJECTED at the
 * gateway for the same read — proving the admin-promotion token is the *right* shape, not
 * merely that "something read".
 *
 * All `client.resources.*` — the public mesh CLIENT surface (never raw stub RPC / DO-internal
 * access); `callAsync` under the covers is the only awaitable (mesh.md bright line).
 *
 * The last limb is a second tab of the same person: a client constructed with no token and no
 * scope, which subscribes in the same turn, before its first refresh has answered. It names no
 * host to call until that token's `aud` says which, so the subscription has to wait for it.
 * Mutation: call at once with the scope still unknown, and the snapshot never arrives.
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID, NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Snapshot } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import {
  connectDriver, mintDegradedToken, assertTokenRejected, scopeUrlOf, constructionPairs, readDevVar,
} from '../lib/harness';
import { sharedApp } from '../lib/shared-app';

export async function run(stack: DevStack): Promise<void> {
  const marker = `harness-marker-${crypto.randomUUID()}`;
  // The run's shared app, galaxy-tier, which hosts the chat and resource planes. Its owner signs in
  // through the driver's own cookie jar, which the last limb's second tab refreshes from.
  const app = await sharedApp(stack, readDevVar('TEST_TOKEN'));
  const SCOPE = app.galaxy;
  const driver = await connectDriver(stack, { scope: SCOPE, email: app.ownerEmail });

  try {
    // ── POSITIVE: create Chat + Message (ADR-006 by-id FK, client UUIDs) atomically ──
    // The raw transaction surface, rather than `postUserMessage`, is the mechanism under test.
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const out = await driver.client.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'harness chat' } },
      [messageId]: {
        op: 'create',
        typeName: 'Message',
        nodeId: ROOT_NODE_ID,
        value: { chat: chatId, content: marker },
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
      (readBack.value as { chat: string }).chat,
      chatId,
      'read-back Message.chat must equal the FK (ADR-006 by-id relationship preserved)',
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

    // ── A CLIENT THAT NAMES NO SCOPE FINDS ITS OWN: a second tab, subscribing before its first token ──
    {
      const page = scopeUrlOf(stack, SCOPE);
      const ctx = driver.browser.context(page);
      const early = new NebulaClient({
        baseUrl: page,
        platformOrigin: stack.baseUrl,
        ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
        ...constructionPairs(SCOPE),
        fetch: ctx.fetch,
        sessionStorage: ctx.sessionStorage,
        BroadcastChannel: ctx.BroadcastChannel,
      });
      try {
        assert.equal(early.activeScope, undefined,
          'fixture guard: the subscribe must go out before the first token, or it proves nothing about the wait');
        using sub = early.resources.subscribe('Message', messageId);
        const snap = await sub.snapshot;
        assert.equal((snap?.value as { content: string } | undefined)?.content, marker,
          "a subscription made before the first token must reach this host's own resource host");
        assert.equal(early.activeScope, SCOPE, "the client's scope must be its host's, read from the token's aud");
      } finally {
        early[Symbol.dispose]();
        ctx.close();
      }
    }

    // (No wipe: the galaxy tier has no `resetDevData`; the deterministic local reset is the
    // fresh boot.)
  } finally {
    driver.dispose();
  }
}
