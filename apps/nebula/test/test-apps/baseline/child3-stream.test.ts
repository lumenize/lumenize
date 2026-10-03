/**
 * Child 3 — the option-(b) streaming mechanism, driven through a real scripted turn.
 *
 * The assistant's live progress rides a TRANSIENT `lmz.broadcast(handleStreamChunk)`
 * push (no Resource write); at completion ONE durable `Message` is committed and the
 * client reconciles the ephemeral stream against it by the agent message's id. Each test
 * runs `runTriggeredTurn` against the scripted model (`chatScriptedForTest`), so the chunks
 * come from the turn's own progress steps — a `build` round streams `building…` — and the
 * plane's `streamProgress` decides who receives them.
 *
 * Assertions target the TRANSIENT surface, not the self-healing end-state (testing.md:24 —
 * the durable query rerun repairs the membership regardless, so an end-state "one copy"
 * check is vacuous):
 *   - M3a: a chunk is observed BEFORE any durable Message exists in membership. The script
 *          holds round 2 with `{ __delayMs }`, as `source-chat-floor.test.ts` F5 does, so the
 *          commit lands well after the chunk.
 *   - M3b: after the durable commit, the ephemeral stream is reconciled AWAY (no dup).
 *   - M1 : a subscriber DENIED on the chat node receives ZERO chunks.
 *
 * Mutation-checks (verifier / by hand): commit the agent Message before the turn's first chunk
 * → M3a's `not.toContain` fails; delete the reconcile in `handleResourceUpdate` → M3b's
 * `streamingProgress===undefined` fails; send the chunk to every query subscriber (drop the
 * plane's read filter) → M1's denied count goes >0.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_CHAT_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient, createInvitedClient, createSubject } from '../../test-helpers';
import { deriveKind } from '@lumenize/nebula';
import { NebulaClientTest } from './index';

const uniqueChatScope = () => `c3st-${crypto.randomUUID().slice(0, 8)}.app`;
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

/** Round 1 calls `build` (its step streams `building…`); round 2 marks complete. */
const BUILD_ROUND = { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
  { id: 'b1', type: 'function', function: { name: 'build', arguments: '{}' } },
] } }] };
const COMPLETE_ROUND = { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
  { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
] } }] };

describe('child3 — transient progress stream + durable Message', () => {
  it('streams a chunk BEFORE the durable Message, then reconciles the ephemeral away by id', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);

    using sub = client.resources.subscribeQuery(chatQuery);
    await sub.ready;
    expect(sub.resourceIds).toEqual([]);

    // The model is held 500 ms after the build round, so the turn's commit trails its chunk.
    client.callGalaxyChatScripted(scope, 'build it', [BUILD_ROUND, { __delayMs: 500 }, COMPLETE_ROUND]);
    await vi.waitFor(() => expect(client.lastStreamChunk?.progress).toBe('building…'));
    const agentMessageId = client.lastStreamChunk!.messageId;
    // M3a: a chunk arrived, and NO durable Message exists in membership yet.
    expect(client.streamingProgress(agentMessageId)).toBe('building…');
    expect(sub.resourceIds).not.toContain(agentMessageId);

    // The turn commits ONE durable Message at that id; membership gains it via the query rerun.
    await vi.waitFor(() => expect(sub.resourceIds).toContain(agentMessageId));

    // Render it → the content sub hydrates → reconcile drops the ephemeral stream (M3b).
    sub.setRenderWindow([agentMessageId]);
    await vi.waitFor(() => expect(client.streamingProgress(agentMessageId)).toBeUndefined());
    const durable = await client.resources.read('Message', agentMessageId) as Snapshot;
    // Agent-ness is DERIVED from the actor stamp, never a stored role.
    expect(deriveKind(durable.meta.actingToken)).toBe('agent');

    client[Symbol.dispose]();
  });

  it('a subscriber DENIED on the chat node receives ZERO chunks (M1 transient recheck)', async () => {
    const scope = uniqueChatScope();
    const { client: admin, accessToken } = await devClient(scope);

    // A non-admin with NO grant on CHAT_NODE_ID (ROOT). It subscribes the query, so
    // it WOULD receive chunks if the transient push skipped the permission recheck.
    const adminBrowser = new Browser();
    await createSubject(adminBrowser, scope, accessToken, 'denied@example.com');
    const { client: denied } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'denied@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });

    using sa = admin.resources.subscribeQuery(chatQuery); await sa.ready;
    using sd = denied.resources.subscribeQuery(chatQuery); await sd.ready;
    const deniedUpdates = denied.queryUpdateCount;

    // The turn streams to CHAT_NODE_ID's readers: admin (access.scopeAdmin bypass) is one; denied is not.
    admin.callGalaxyChatScripted(scope, 'build it', [BUILD_ROUND, COMPLETE_ROUND]);
    await vi.waitFor(() => expect(admin.streamChunkCount).toBeGreaterThanOrEqual(1));
    // A same-connection barrier: the turn's commit reaches `denied` as a query update, and the
    // chunks were sent before it, so any chunk that leaked would have landed by now.
    await vi.waitFor(() => expect(denied.queryUpdateCount).toBeGreaterThan(deniedUpdates));

    // The admin received a chunk (proves the push fired); the denied subscriber received NONE.
    expect(denied.streamChunkCount).toBe(0);

    admin[Symbol.dispose](); denied[Symbol.dispose]();
  });

  it('every chunk carries the id of the USER message whose turn is streaming — a peer can tell whose it is', async () => {
    // The stream goes to the whole chat (a shared thread — watching someone else's reply appear
    // is the product working), so the recipient needs the attribution to know whether it is
    // liveness for its OWN turn. Without it, a client whose message the single-flight latch
    // SKIPPED — and which will therefore never be answered — has its idle window re-armed by the
    // running turn's chunks and never surfaces `failed`: the hang the liveness reducer exists to
    // convert into a banner.
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    const triggeringUserMessage = crypto.randomUUID();

    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    client.callGalaxyChatScripted(scope, 'build it', [BUILD_ROUND, COMPLETE_ROUND], triggeringUserMessage);
    await vi.waitFor(() => expect(client.streamChunkCount).toBeGreaterThanOrEqual(1));

    // The attribution reaches the client intact — NOT the agent message's own id, which
    // is what a recipient cannot correlate against anything it knows.
    expect(client.lastStreamReplyTo).toBe(triggeringUserMessage);
    expect(client.lastStreamReplyTo).not.toBe(client.lastStreamChunk!.messageId);

    client[Symbol.dispose]();
  });
});
