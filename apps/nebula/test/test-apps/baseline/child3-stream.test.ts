/**
 * Child 3 Phase 3 — the option-(b) streaming mechanism (Stage-2 M1 + M3).
 *
 * The assistant's live progress rides a TRANSIENT `svc.broadcast(handleStreamChunk)`
 * push (no Resource write); at completion ONE durable `Message` is committed and the
 * client reconciles the ephemeral stream against it by `assistantMessageId`. Real `chat`
 * codegen is wrangler-dev-only, so these drive `streamProgress` + `commitAssistantMessage`
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
import { generateUuid } from '@lumenize/auth';
import { DEFAULT_SESSION_ID, SESSION_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueDevScope = () => `c3st-${generateUuid().slice(0, 8)}.app.dev`;
const sessionQuery = {
  queryType: 'parentChild' as const, typeName: 'Message', field: 'session', value: DEFAULT_SESSION_ID,
};

function devClient(scope: string, email = 'admin@example.com') {
  return createAuthenticatedClient(
    NebulaClientTest, new Browser(), scope, scope, email, 'v1',
    { resourceHostBinding: 'DEV_STUDIO' },
  );
}

describe('child3 Phase 3 — transient progress stream + durable Message (M1/M3)', () => {
  it('streams chunks BEFORE the durable Message, then reconciles the ephemeral away by id', async () => {
    const scope = uniqueDevScope();
    const { client } = await devClient(scope);
    const messageId = generateUuid();

    using sub = client.resources.subscribeQuery(sessionQuery);
    await sub.ready;
    expect(sub.resourceIds).toEqual([]);

    // Stream two chunks (transient — NO Resource write). The client accumulates them.
    client.callDevStudioStreamChunk(scope, DEFAULT_SESSION_ID, messageId, 'Writing ', SESSION_NODE_ID);
    await vi.waitFor(() => expect(client.streamChunkCount).toBeGreaterThanOrEqual(1));
    // M3a: a chunk arrived, and NO durable Message exists in membership yet.
    expect(client.streamingProgress(messageId)).toBe('Writing ');
    expect(sub.resourceIds).not.toContain(messageId);

    client.callDevStudioStreamChunk(scope, DEFAULT_SESSION_ID, messageId, 'App.vue…', SESSION_NODE_ID);
    await vi.waitFor(() => expect(client.streamingProgress(messageId)).toBe('Writing App.vue…')); // accumulates

    // Commit the durable Message. Membership gains it via the query rerun.
    client.callDevStudioCommitAssistant(scope, DEFAULT_SESSION_ID, messageId, 'Updated the preview.', SESSION_NODE_ID);
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();
    await vi.waitFor(() => expect(sub.resourceIds).toContain(messageId));

    // Render it → the content sub hydrates → reconcile drops the ephemeral stream (M3b).
    sub.setRenderWindow([messageId]);
    await vi.waitFor(() => expect(client.streamingProgress(messageId)).toBeUndefined());
    const durable = await client.resources.read('Message', messageId) as Snapshot;
    expect((durable.value as { content?: string; role?: string }).content).toBe('Updated the preview.');
    expect((durable.value as { role?: string }).role).toBe('assistant');

    client[Symbol.dispose]();
  });

  it('a subscriber DENIED on the assistant node receives ZERO chunks (M1 transient recheck)', async () => {
    const scope = uniqueDevScope();
    const { client: admin, accessToken } = await devClient(scope);
    const messageId = generateUuid();

    // A non-admin with NO grant on SESSION_NODE_ID (ROOT). It subscribes the query, so
    // it WOULD receive chunks if the transient push skipped the permission recheck.
    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'denied@example.com');
    const { client: denied } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), scope, scope, 'denied@example.com', 'v1', { resourceHostBinding: 'DEV_STUDIO' });

    using sa = admin.resources.subscribeQuery(sessionQuery); await sa.ready;
    using sd = denied.resources.subscribeQuery(sessionQuery); await sd.ready;

    // Stream to SESSION_NODE_ID: admin (access.admin bypass) is a target; denied is not.
    admin.callDevStudioStreamChunk(scope, DEFAULT_SESSION_ID, messageId, 'thinking…', SESSION_NODE_ID);
    await vi.waitFor(() => expect(admin.streamChunkCount).toBeGreaterThanOrEqual(1));

    // The admin received the chunk (proves the broadcast fired); the denied subscriber
    // must have received NONE. (Capable-of-failing: drop the recheck → denied count >0.)
    expect(denied.streamChunkCount).toBe(0);
    expect(denied.streamingProgress(messageId)).toBeUndefined();

    admin[Symbol.dispose](); denied[Symbol.dispose]();
  });
});
