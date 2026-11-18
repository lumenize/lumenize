/**
 * The `read_file` RECORD is `{ path, bytes, oid }`, never the content (`.claude/rules/studio-guidance.md`).
 * The content is kept in the Workspace's git store under `oid`, and the round that records the
 * call reaches every reader of the turn's rounds, so a read of the 76 KB API reference must leave
 * the round small, and the durable agent Message's `codegen` too. Driven through the REAL commit
 * path: a scripted turn whose only tool call reads that page, then its round and its reply read back.
 *
 * Mutation-validated (testing.md): record the read's `content` in the loop instead of its
 * length → the serialized round is two orders of magnitude over the bound → red.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_CHAT_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, deriveKind } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/resources';
import { universeAdminClient, turnCallsOf } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueScope = () => `rrd-${crypto.randomUUID().slice(0, 8)}.app`;
const chatQuery = {
  typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID },
};

/** A read of the biggest platform page, then a text-only round (the loop's safe stop). */
const READ_THEN_ANSWER = [
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '.platform/docs/api-reference.md' }) } },
  ] } }] },
  { choices: [{ message: { content: 'I read the API reference.', reasoning_content: '', tool_calls: [] } }] },
];

describe('the read_file record', () => {
  it('after a turn whose only tool call reads .platform/docs/api-reference.md, the serialized codegen value is under a kilobyte', async () => {
    const scope = uniqueScope();
    const { client } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
      { resourceHostBinding: 'GALAXY' },
    );
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;

    const userMessageId = crypto.randomUUID();
    client.callGalaxyChatScripted(scope, 'what does the API look like?', READ_THEN_ANSWER, userMessageId);
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();

    let reply: Snapshot | undefined;
    let replyId = '';
    await vi.waitFor(async () => {
      for (const id of sub.resourceIds) {
        const snap = await client.resources.read('Message', id) as Snapshot | null;
        if (snap && deriveKind(snap.meta.recordedClaims) === 'agent' && (snap.value as { replyTo?: string }).replyTo === userMessageId) {
          reply = snap;
          replyId = id;
        }
      }
      expect(reply).toBeTruthy();
    }, { timeout: 15000 });

    const codegen = (reply!.value as { codegen?: Record<string, unknown> }).codegen!;
    // Positive control: the read HAPPENED and was recorded — the whole page's size is in
    // the record — so the bound below is measuring a record that saw 76 KB go by.
    const calls = await turnCallsOf(client, scope, replyId);
    const read = calls.find((t) => t.name === 'read_file') as { result?: { path?: string; bytes?: number } } | undefined;
    expect(read?.result?.path).toBe('.platform/docs/api-reference.md');
    expect(read?.result?.bytes).toBeGreaterThan(50_000);
    expect(JSON.stringify(calls).length).toBeLessThan(1024);
    expect(JSON.stringify(codegen).length).toBeLessThan(1024);

    client[Symbol.dispose]();
  });
});
