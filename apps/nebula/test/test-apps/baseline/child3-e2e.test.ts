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
import { DEFAULT_CHAT_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient } from '../../test-helpers';
import { deriveKind } from '@lumenize/nebula';
import { NEBULA_SUB } from '@lumenize/nebula-auth';
import { NebulaClientTest } from './index';

const uniqueChatScope = () => `c3e-${crypto.randomUUID().slice(0, 8)}.app`;
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

describe('child3 Phase 6 — history-restore + multi-participant e2e', () => {
  it('a late-joining participant restores the full ordered conversation from durable Messages alone', async () => {
    const scope = uniqueChatScope();
    const { client: sender } = await devClient(scope);
    const a1 = crypto.randomUUID(), a2 = crypto.randomUUID();

    // Build the conversation as durable Messages, alternating user/assistant. Sequential
    // awaits → advancing clock → chronological (validFrom, resourceId) order.
    const u1 = await sender.postUserMessage('add a counter');
    sender.callGalaxyCommitAgent(scope, DEFAULT_CHAT_ID, a1, 'Added the counter.', CHAT_NODE_ID, u1);
    await vi.waitFor(() => expect(sender.callCompleted).toBe(true));
    expect(sender.lastError).toBeUndefined();

    const u2 = await sender.postUserMessage('make it blue');
    sender.callGalaxyCommitAgent(scope, DEFAULT_CHAT_ID, a2, 'Styled it blue.', CHAT_NODE_ID, u2);
    await vi.waitFor(() => expect(sender.callCompleted).toBe(true));
    expect(sender.lastError).toBeUndefined();

    // A LATE participant joins — it never saw any live push — and subscribes. It gets the
    // WHOLE ordered history from the durable Messages (history-restore + recovery + multi-
    // participant, all at once). Capable-of-failing: if the assistant reply were only an
    // ephemeral push (not a durable Message), the coach would miss a1/a2 entirely.
    const { client: coach } = await devClient(scope);
    using sc = coach.resources.subscribeQuery(chatQuery); await sc.ready;
    await vi.waitFor(() => expect(sc.resourceIds).toEqual([u1, a1, u2, a2]));

    // Kinds alternate human/agent across the restored history — DERIVED from each
    // message's stamped actingToken (never a stored role) — and content is intact.
    const snaps: Snapshot[] = [];
    for (const id of sc.resourceIds) {
      snaps.push(await coach.resources.read('Message', id) as Snapshot);
    }
    expect(snaps.map((m) => deriveKind(m.meta.actingToken))).toEqual(['human', 'agent', 'human', 'agent']);
    expect(snaps.map((m) => (m.value as { content?: string }).content)).toEqual([
      'add a counter', 'Added the counter.', 'make it blue', 'Styled it blue.',
    ]);
    // The agent messages carry the REQUIRED replyTo ref (the corpus prompt→reply link)
    // and the always-emitted Nebula actor pair (`sub` AND `profileId` — no Registry
    // lookup ever needed to display a Nebula reply).
    expect((snaps[1].value as { replyTo?: string }).replyTo).toBe(u1);
    expect((snaps[3].value as { replyTo?: string }).replyTo).toBe(u2);
    expect(snaps[1].meta.actingToken.act).toMatchObject({ sub: NEBULA_SUB, profileId: NEBULA_SUB });
    // The coach received the conversation with ZERO ephemeral chunks (pure durable recovery).
    expect(coach.streamChunkCount).toBe(0);

    sender[Symbol.dispose](); coach[Symbol.dispose]();
  });

  it('CODEGEN CORPUS: an agent turn round-trips codegen.gate + codegen.appliedPaths intact; a human message has no codegen', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);

    const u1 = await client.postUserMessage('add a ping button');
    // The folded corpus record — the value-object EMBED (never an ADR-006 by-id rewrite),
    // shaped like Galaxy.chat's real write. In-lane the model is unreachable (wrangler-dev
    // only), so the commit initiator carries the record; the live end-to-end producer is
    // the studio-codegen-rest /live scenario.
    const codegen = {
      model: 'test-model', rounds: 1, stop: 'complete',
      appliedPaths: ['src/App.vue', 'src/ping.ts'],
      gate: { ok: true },
      toolCalls: [{ name: 'write_file', args: { path: 'src/ping.ts' } }],
    };
    const a1 = crypto.randomUUID();
    client.callGalaxyCommitAgent(scope, DEFAULT_CHAT_ID, a1, 'Added it.', CHAT_NODE_ID, u1, codegen);
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();

    const agent = await client.resources.read('Message', a1) as Snapshot;
    const cg = (agent.value as { codegen?: typeof codegen }).codegen;
    expect(cg?.gate).toEqual({ ok: true });
    expect(cg?.appliedPaths).toEqual(['src/App.vue', 'src/ping.ts']);
    // The HUMAN message carries no codegen — the field marks the agent's corpus record only.
    const human = await client.resources.read('Message', u1) as Snapshot;
    expect('codegen' in (human.value as Record<string, unknown>)).toBe(false);

    client[Symbol.dispose]();
  });
});
