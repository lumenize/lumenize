/**
 * The client posts a human Message + attribution derives ONLY from the stamp.
 *
 * `NebulaClient.postUserMessage` (the create half of `chat`) writes ONE atomic Message
 * carrying NO identity fields — attribution comes entirely from the server-stamped
 * `meta.actingToken` (verified claims), which is what makes author spoofing impossible.
 * It rides the chat query, so the sender AND a second subscriber both see it via the
 * fanout — the sender does NOT optimistically echo (D-echo default: wait for the
 * rerun). A user message is never streamed (no `handleStreamChunk` fires for it).
 *
 * The spoof criteria live here too: a client smuggling `author`/`role` keys through the
 * raw transaction surface cannot alter the DERIVED attribution (the derivation reads
 * only the stamp — assert the render, never absence-from-storage: typia won't strip).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, deriveKind, deriveParticipants } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { env } from 'cloudflare:test';
import { NEBULA_SUB } from '@lumenize/nebula-auth';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import { universeAdminClient, ORIGIN } from '../../test-helpers';
import { NebulaClientTest, GalaxyTest } from './index';

const uniqueChatScope = () => `c3p-${crypto.randomUUID().slice(0, 8)}.app`;
const chatQuery = {
  queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID,
};

  // ⚠️ `universeAdminClient`, not `adminClientAt`: chat lives at the GALAXY tier ({u}.{g})
  // post-collapse, and `adminClientAt` is star-tier only — the covering universe admin is how
  // a galaxy is administered.
function devClient(scope: string, email = 'admin@example.com') {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, email, CHAT_MESSAGE_ONTOLOGY_VERSION,
    { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
  );
}

describe('child3 Phase 4 — client posts the user Message', () => {
  it('sender and a 2nd subscriber both see posted user Messages in send order; no streaming for a user message', async () => {
    const scope = uniqueChatScope();
    const { client: sender, payload: senderPayload } = await devClient(scope);
    const { client: observer } = await devClient(scope); // distinct participant (same admin email, different client)

    using ss = sender.resources.subscribeQuery(chatQuery); await ss.ready;
    using so = observer.resources.subscribeQuery(chatQuery); await so.ready;
    expect(ss.resourceIds).toEqual([]);

    // Sender posts m1, then observer posts m2 (separate transactions, advancing clock →
    // distinct validFrom → chronological order).
    const m1 = await sender.postUserMessage('hello from sender');
    await vi.waitFor(() => expect(ss.resourceIds).toContain(m1));   // sender sees its OWN via the fanout (no echo)
    await vi.waitFor(() => expect(so.resourceIds).toContain(m1));   // observer sees it too

    const m2 = await observer.postUserMessage('hi from observer');
    // Both clients converge on the same ordered membership [m1, m2].
    await vi.waitFor(() => expect(ss.resourceIds).toEqual([m1, m2]));
    await vi.waitFor(() => expect(so.resourceIds).toEqual([m1, m2]));

    // The observer reads m1: content from the value; ATTRIBUTION only from the stamp.
    const snap = await observer.resources.read('Message', m1) as Snapshot;
    const v = snap.value as { content?: string; author?: string; role?: string };
    expect(v.content).toBe('hello from sender');
    // The writer writes NO identity fields (a value-side author/role would be a second,
    // forgeable source of truth). Capable-of-failing: restore the old value-side stamps → red.
    expect(v.author).toBeUndefined();
    expect(v.role).toBeUndefined();
    // The server-stamped actingToken IS the attribution: the sender's verified sub +
    // profileId, and NO act chain on a human's own message.
    expect(snap.meta.actingToken.sub).toBe(senderPayload.sub);
    expect(snap.meta.actingToken.sub).not.toContain('@'); // never re-anchor on an email
    expect(snap.meta.actingToken.profileId).toBe(senderPayload.profileId);
    expect(snap.meta.actingToken.act).toBeUndefined();
    // The DERIVED display: a human message from the sender, one party.
    expect(deriveKind(snap.meta.actingToken)).toBe('human');
    expect(deriveParticipants(snap.meta.actingToken)).toEqual([
      { sub: senderPayload.sub, kind: 'human', profileId: senderPayload.profileId },
    ]);
    expect(snap.meta.nodeId).toBe(CHAT_NODE_ID);

    // D-human-no-stream: posting a user Message streams NOTHING (a single atomic create,
    // not the assistant progress path). Capable-of-failing: wiring a stream into the post
    // would make these non-zero.
    expect(sender.streamChunkCount).toBe(0);
    expect(observer.streamChunkCount).toBe(0);

    sender[Symbol.dispose](); observer[Symbol.dispose]();
  });

  it('CHAT PAIR: no pair → loud throw on postUserMessage; a MIXED-pair client writes to the CHAT host, never the resource pair', async () => {
    const scope = uniqueChatScope();
    // ONE identity throughout — the subject here is ROUTING, and a claimed universe only
    // logs its own admin back in (a second email would 401 at refresh).
    const email = 'pairfence@example.com';

    // (a) The loud throw — resource pair present (the tempting fallback), chat pair absent.
    const { client: pairless } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, email, CHAT_MESSAGE_ONTOLOGY_VERSION,
      { resourceHostBinding: 'GALAXY' },
    );
    await expect(pairless.postUserMessage('hi')).rejects.toThrow(/no chat host/);

    // (b) The misroute fence needs a fixture whose two pairs genuinely DIFFER (same-pair fixtures
    // are the safe shape — a fallback would be invisible): resources at the STAR `.dev` tier,
    // chat at the covering GALAXY. The posted Message must be readable on the GALAXY plane.
    const { client: mixed } = await universeAdminClient(
      NebulaClientTest, new Browser(), `${scope}.dev`, `${scope}.dev`, email,
      CHAT_MESSAGE_ONTOLOGY_VERSION,
      { resourceHostBinding: 'STAR', chatHostBinding: 'GALAXY', chatScope: scope },
    );
    const posted = await mixed.postUserMessage('routed to the galaxy');
    const { client: galaxyReader } = await devClient(scope, email);
    const snap = await galaxyReader.resources.read('Message', posted) as Snapshot;
    expect((snap.value as { content?: string }).content).toBe('routed to the galaxy');
    expect(snap.meta.nodeId).toBe(CHAT_NODE_ID);

    pairless[Symbol.dispose](); mixed[Symbol.dispose](); galaxyReader[Symbol.dispose]();
  });

  it('SPOOF FENCE: smuggled author/role keys + a seeded CallOptions.state cannot alter the derived attribution', async () => {
    const scope = uniqueChatScope();
    const { client: mallory, payload } = await devClient(scope, 'mallory@example.com');

    // Post through the RAW transaction surface with forged identity keys in the value.
    // typia is non-strict — they persist at rest — but the derivation never reads them.
    const forgedId = crypto.randomUUID();
    const out = await mallory.resources.transaction({
      [forgedId]: {
        op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID,
        value: { chat: DEFAULT_CHAT_ID, content: 'hi', author: 'the-ceo', role: 'assistant' },
      },
    });
    expect(out.kind).toBe('committed');

    const snap = await mallory.resources.read('Message', forgedId) as Snapshot;
    // The forged keys persisted (non-strict — assert the RENDER, never absence-from-storage)…
    expect((snap.value as { author?: string }).author).toBe('the-ceo');
    // …and change NOTHING: attribution derives from the verified stamp alone. A client
    // cannot supply an `actor` either — the @mesh transaction entry has no such
    // parameter (the trust fence), so `act` is absent and the kind is human.
    expect(snap.meta.actingToken.sub).toBe(payload.sub);
    expect(snap.meta.actingToken.act).toBeUndefined();
    expect(deriveKind(snap.meta.actingToken)).toBe('human');

    mallory[Symbol.dispose]();
  });

  it('STATE FENCE: a seeded CallOptions.state cannot alter the stamped actor', async () => {
    const scope = uniqueChatScope();
    const { client, payload } = await devClient(scope, 'stately@example.com');
    const messageId = crypto.randomUUID();
    // Seed `state` with actor-shaped keys on the raw call. `#buildActingToken` reads ONLY
    // `callContext.originAuth` (verified claims) + the server-internal write-option, so
    // the seeded state changes nothing. Capable-of-failing: read the actor out of
    // `callContext.state` server-side → this stamps an act chain → red.
    const result = await client.lmz.callAsync(
      'GALAXY', scope,
      client.ctn<GalaxyTest>().transaction(CHAT_MESSAGE_ONTOLOGY_VERSION, crypto.randomUUID(), {
        [messageId]: {
          op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID,
          value: { chat: DEFAULT_CHAT_ID, content: 'hi' },
        },
      }),
      { state: { actor: { sub: NEBULA_SUB, profileId: NEBULA_SUB } } },
    );
    expect((result as { ok?: boolean }).ok).toBe(true);
    const snap = await client.resources.read('Message', messageId) as Snapshot;
    expect(snap.meta.actingToken.sub).toBe(payload.sub);
    expect(snap.meta.actingToken.act).toBeUndefined();
    expect(deriveKind(snap.meta.actingToken)).toBe('human');
    client[Symbol.dispose]();
  });

  it('ACT-BEARING trigger: the coach entry is PRESERVED beneath the Nebula actor (depth-2 chain — a flatten reds)', async () => {
    const scope = uniqueChatScope();
    // Seed the chat host (the Chat row) with an ordinary admin first.
    const { client: admin } = await devClient(scope);

    // An act-bearing session: the coach driving the user's authority — the claim shape a
    // real `impersonate()` mint produces. Rung-3 mint, justified per-site (ADR-009): the
    // subject here is the CHAIN SEMANTICS of the stamp, and the real impersonation path is
    // exercised end-to-end by the Phase-4 /live headline; the mint isolates the depth-2
    // nesting without enrolling a second identity through the full invite flow.
    const userSub = crypto.randomUUID();
    const userProfile = crypto.randomUUID();
    const coachSub = crypto.randomUUID();
    const coachProfile = crypto.randomUUID();
    const { access_token } = await createNebulaTestToken({
      privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
      activeScope: scope, instanceName: scope, scopeAdmin: true,
      sub: userSub, profileId: userProfile,
      actor: { sub: coachSub, profileId: coachProfile },
      ttlSeconds: 3600,
    })();
    const browser = new Browser();
    const ctx = browser.context(ORIGIN);
    const impersonated = new NebulaClientTest({
      baseUrl: ORIGIN, authScope: scope, activeScope: scope,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope,
      accessToken: access_token, instanceName: `${userSub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: browser.fetch, WebSocket: browser.WebSocket,
      sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
    });
    await vi.waitFor(() => expect(impersonated.connectionState).toBe('connected'));

    // The impersonated session posts: subject = user, actor = coach (depth 1).
    const u1 = await impersonated.postUserMessage('do it for me');
    const human = await impersonated.resources.read('Message', u1) as Snapshot;
    expect(human.meta.actingToken).toMatchObject({
      sub: userSub, profileId: userProfile,
      act: { sub: coachSub, profileId: coachProfile },
    });

    // The agent reply commits under that same act-bearing context: Nebula prepends as the
    // NEW OUTERMOST entry and the coach SURVIVES beneath (RFC 8693 — a flatten drops it).
    const a1 = crypto.randomUUID();
    impersonated.callGalaxyCommitAgent(scope, DEFAULT_CHAT_ID, a1, 'Done.', CHAT_NODE_ID, u1);
    await vi.waitFor(() => expect(impersonated.callCompleted).toBe(true));
    expect(impersonated.lastError).toBeUndefined();
    const agent = await impersonated.resources.read('Message', a1) as Snapshot;
    expect(agent.meta.actingToken).toMatchObject({
      sub: userSub,
      act: { sub: NEBULA_SUB, profileId: NEBULA_SUB, act: { sub: coachSub, profileId: coachProfile } },
    });
    // The byline walk, top-down: Nebula for {coach} for {user}.
    expect(deriveParticipants(agent.meta.actingToken).map((p) => [p.sub, p.kind])).toEqual([
      [NEBULA_SUB, 'agent'], [coachSub, 'human'], [userSub, 'human'],
    ]);

    admin[Symbol.dispose]();
    impersonated[Symbol.dispose]();
  });
});
