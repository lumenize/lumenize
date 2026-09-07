/**
 * The `read_file` RECORD is `{ path, bytes }`, never the content (`.claude/rules/studio-guidance.md`). The model already holds what it read as the in-turn tool result, and the
 * stored `codegen.toolCalls` fans to every subscribed client through the durable agent
 * Message — so a read of the 76 KB API reference must leave the record small. Driven
 * through the REAL commit path: a scripted turn whose only tool call reads that page,
 * then the durable reply's `codegen` value read back off the thread.
 *
 * Mutation-validated (testing.md): record the read's `content` in the loop instead of its
 * length → the serialized value is two orders of magnitude over the bound → red.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_CHAT_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, deriveKind } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueScope = () => `rrd-${crypto.randomUUID().slice(0, 8)}.app`;
const chatQuery = {
  queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID,
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
      { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
    );
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;

    const userMessageId = crypto.randomUUID();
    client.callGalaxyChatScripted(scope, 'what does the API look like?', READ_THEN_ANSWER, userMessageId);
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();

    let reply: Snapshot | undefined;
    await vi.waitFor(async () => {
      for (const id of sub.resourceIds) {
        const snap = await client.resources.read('Message', id) as Snapshot | null;
        if (snap && deriveKind(snap.meta.actingToken) === 'agent' && (snap.value as { replyTo?: string }).replyTo === userMessageId) {
          reply = snap;
        }
      }
      expect(reply).toBeTruthy();
    }, { timeout: 15000 });

    const codegen = (reply!.value as { codegen?: Record<string, unknown> }).codegen!;
    // Positive control: the read HAPPENED and was recorded — the whole page's size is in
    // the record — so the bound below is measuring a record that saw 76 KB go by.
    const read = (codegen.toolCalls as Array<{ name: string; result?: { path?: string; bytes?: number } }>).find((t) => t.name === 'read_file');
    expect(read?.result?.path).toBe('.platform/docs/api-reference.md');
    expect(read?.result?.bytes).toBeGreaterThan(50_000);
    expect(JSON.stringify(codegen).length).toBeLessThan(1024);

    client[Symbol.dispose]();
  });
});
