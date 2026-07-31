/**
 * Child 3 Phase 6 — history-restore + multi-participant + disconnect-recovery (Flow B/C).
 *
 * The capstone: a mini conversation (user → assistant → user → assistant) is built from
 * DURABLE Messages (user posts via postUserMessage; assistant via the Phase-3 commit).
 * A LATE-joining participant (the "coach") — which received NONE of the ephemeral progress
 * pushes — subscribes the session query and gets the FULL, ORDERED history from the durable
 * Messages alone. That single property IS the fix for all three motivating failures:
 *   - history-restore on refresh (a reload is just a fresh subscribe → full membership),
 *   - completed-while-disconnected / "thinking forever" (the reply is a durable Message,
 *     recovered via the query sub with no pending-Promise / ephemeral-push dependency),
 *   - multi-participant (a 2nd participant sees the conversation).
 * The ephemeral onChatResult path is thereby DEMOTED to a live-only optimization — the
 * durable Message is the source of truth.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_SESSION_ID, SESSION_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueDevScope = () => `c3e-${crypto.randomUUID().slice(0, 8)}.app.dev`;
const sessionQuery = {
  queryType: 'parentChild' as const, typeName: 'Message', field: 'session', value: DEFAULT_SESSION_ID,
};

  // ⚠️ `universeAdminClient`, not `adminClientAt`: a `{u}.{g}.dev` star is FOUNDERLESS by
  // construction — `create-star` mints no founder and `claim-star` refuses the reserved slug — so it
  // is administered by the covering admin's wildcard. That is how it works in production, not a test
  // concession. (`adminClientAt` refuses this scope outright for exactly that reason.)
function devClient(scope: string, email = 'admin@example.com') {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, email, 'v1',
    { resourceHostBinding: 'DEV_STUDIO' },
  );
}

describe('child3 Phase 6 — history-restore + multi-participant e2e', () => {
  it('a late-joining participant restores the full ordered conversation from durable Messages alone', async () => {
    const scope = uniqueDevScope();
    const { client: sender } = await devClient(scope);
    const a1 = crypto.randomUUID(), a2 = crypto.randomUUID();

    // Build the conversation as durable Messages, alternating user/assistant. Sequential
    // awaits → advancing clock → chronological (validFrom, resourceId) order.
    const u1 = await sender.postUserMessage('add a counter');
    sender.callDevStudioCommitAssistant(scope, DEFAULT_SESSION_ID, a1, 'Added the counter.', SESSION_NODE_ID);
    await vi.waitFor(() => expect(sender.callCompleted).toBe(true));
    expect(sender.lastError).toBeUndefined();

    const u2 = await sender.postUserMessage('make it blue');
    sender.callDevStudioCommitAssistant(scope, DEFAULT_SESSION_ID, a2, 'Styled it blue.', SESSION_NODE_ID);
    await vi.waitFor(() => expect(sender.callCompleted).toBe(true));
    expect(sender.lastError).toBeUndefined();

    // A LATE participant joins — it never saw any live push — and subscribes. It gets the
    // WHOLE ordered history from the durable Messages (history-restore + recovery + multi-
    // participant, all at once). Capable-of-failing: if the assistant reply were only an
    // ephemeral push (not a durable Message), the coach would miss a1/a2 entirely.
    const { client: coach } = await devClient(scope);
    using sc = coach.resources.subscribeQuery(sessionQuery); await sc.ready;
    await vi.waitFor(() => expect(sc.resourceIds).toEqual([u1, a1, u2, a2]));

    // Roles alternate user/assistant across the restored history; content is intact.
    const seen: Array<{ role?: string; content?: string }> = [];
    for (const id of sc.resourceIds) {
      const s = await coach.resources.read('Message', id) as Snapshot;
      seen.push(s.value as { role?: string; content?: string });
    }
    expect(seen.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(seen.map((m) => m.content)).toEqual([
      'add a counter', 'Added the counter.', 'make it blue', 'Styled it blue.',
    ]);
    // The coach received the conversation with ZERO ephemeral chunks (pure durable recovery).
    expect(coach.streamChunkCount).toBe(0);

    sender[Symbol.dispose](); coach[Symbol.dispose]();
  });
});
