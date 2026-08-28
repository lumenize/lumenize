/**
 * Child 3 Phase 3 — the option-(b) streaming mechanism (Stage-2 M1 + M3).
 *
 * The assistant's live progress rides a TRANSIENT `svc.broadcast(handleStreamChunk)`
 * push (no Resource write); at completion ONE durable `Message` is committed and the
 * client reconciles the ephemeral stream against it by `assistantMessageId`. Real `chat`
 * codegen is wrangler-dev-only, so these drive `streamProgress` + `commitAgentMessage`
 * directly with synthetic progress (the mechanism, not the model).
 *
 * Assertions target the TRANSIENT surface, not the self-healing end-state (testing.md:24 —
 * the durable query rerun repairs the membership regardless, so an end-state "one copy"
 * check is vacuous):
 *   - M3a: a chunk is observed BEFORE any durable Message exists in membership.
 *   - M3b: after the durable commit, the ephemeral stream is reconciled AWAY (no dup).
 *   - M1 : a subscriber DENIED on the assistant node receives ZERO chunks.
 *
 * Mutation-checks (verifier / by hand): delete the reconcile in `handleResourceUpdate` →
 * M3b's `streamingProgress===undefined` fails; drop the `queryTargets` recheck (target all
 * subscribers) → M1's denied count goes >0.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient, createInvitedClient, browserLogin, foundAndLogin, createSubject } from '../../test-helpers';
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

describe('child3 Phase 3 — transient progress stream + durable Message (M1/M3)', () => {
  it('streams chunks BEFORE the durable Message, then reconciles the ephemeral away by id', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    const messageId = crypto.randomUUID();

    using sub = client.resources.subscribeQuery(chatQuery);
    await sub.ready;
    expect(sub.resourceIds).toEqual([]);

    // Stream two chunks (transient — NO Resource write). The client accumulates them.
    client.callGalaxyStreamChunk(scope, DEFAULT_CHAT_ID, messageId, 'Writing ', CHAT_NODE_ID);
    await vi.waitFor(() => expect(client.streamChunkCount).toBeGreaterThanOrEqual(1));
    // M3a: a chunk arrived, and NO durable Message exists in membership yet.
    expect(client.streamingProgress(messageId)).toBe('Writing ');
    expect(sub.resourceIds).not.toContain(messageId);

    client.callGalaxyStreamChunk(scope, DEFAULT_CHAT_ID, messageId, 'App.vue…', CHAT_NODE_ID);
    await vi.waitFor(() => expect(client.streamingProgress(messageId)).toBe('Writing App.vue…')); // accumulates

    // Commit the durable Message (replyTo = a synthetic prompt id; the linkage criteria
    // live in child3-e2e). Membership gains it via the query rerun.
    client.callGalaxyCommitAgent(scope, DEFAULT_CHAT_ID, messageId, 'Updated the preview.', CHAT_NODE_ID, crypto.randomUUID());
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();
    await vi.waitFor(() => expect(sub.resourceIds).toContain(messageId));

    // Render it → the content sub hydrates → reconcile drops the ephemeral stream (M3b).
    sub.setRenderWindow([messageId]);
    await vi.waitFor(() => expect(client.streamingProgress(messageId)).toBeUndefined());
    const durable = await client.resources.read('Message', messageId) as Snapshot;
    expect((durable.value as { content?: string }).content).toBe('Updated the preview.');
    // Agent-ness is DERIVED from the actor stamp, never a stored role.
    expect(deriveKind(durable.meta.actingToken)).toBe('agent');

    client[Symbol.dispose]();
  });

  it('a subscriber DENIED on the assistant node receives ZERO chunks (M1 transient recheck)', async () => {
    const scope = uniqueChatScope();
    const { client: admin, accessToken } = await devClient(scope);
    const messageId = crypto.randomUUID();

    // A non-admin with NO grant on CHAT_NODE_ID (ROOT). It subscribes the query, so
    // it WOULD receive chunks if the transient push skipped the permission recheck.
    const adminBrowser = new Browser();
    await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'denied@example.com');
    const { client: denied } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'denied@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });

    using sa = admin.resources.subscribeQuery(chatQuery); await sa.ready;
    using sd = denied.resources.subscribeQuery(chatQuery); await sd.ready;

    // Stream to CHAT_NODE_ID: admin (access.scopeAdmin bypass) is a target; denied is not.
    admin.callGalaxyStreamChunk(scope, DEFAULT_CHAT_ID, messageId, 'thinking…', CHAT_NODE_ID);
    await vi.waitFor(() => expect(admin.streamChunkCount).toBeGreaterThanOrEqual(1));

    // The admin received the chunk (proves the broadcast fired); the denied subscriber
    // must have received NONE. (Capable-of-failing: drop the recheck → denied count >0.)
    expect(denied.streamChunkCount).toBe(0);
    expect(denied.streamingProgress(messageId)).toBeUndefined();

    admin[Symbol.dispose](); denied[Symbol.dispose]();
  });

  it('every chunk carries the id of the USER message whose turn is streaming — a peer can tell whose it is', async () => {
    // The stream is a BROADCAST to the whole chat (a shared thread — watching someone
    // else's reply appear is the product working), so the recipient needs the
    // attribution to know whether it is liveness for its OWN turn. Without it, a client
    // whose message the single-flight latch SKIPPED — and which will therefore never be
    // answered — has its idle window re-armed by the running turn's chunks and never
    // surfaces `failed`: the hang the liveness reducer exists to convert into a banner.
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    const agentMessageId = crypto.randomUUID();
    const triggeringUserMessage = crypto.randomUUID();

    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    client.callGalaxyStreamChunk(
      scope, DEFAULT_CHAT_ID, agentMessageId, 'thinking…', CHAT_NODE_ID, triggeringUserMessage,
    );
    await vi.waitFor(() => expect(client.streamChunkCount).toBeGreaterThanOrEqual(1));

    // The attribution reaches the client intact — NOT the agent message's own id, which
    // is what a recipient cannot correlate against anything it knows.
    expect(client.lastStreamReplyTo).toBe(triggeringUserMessage);
    expect(client.lastStreamReplyTo).not.toBe(agentMessageId);

    client[Symbol.dispose]();
  });
});
