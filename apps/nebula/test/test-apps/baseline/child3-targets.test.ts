/**
 * Child 3 — who a turn's progress chunks reach: the per-operand test of the plane's target filter.
 *
 * `streamProgress` sends a chunk to the chat query's subscribers that pass
 * `evaluatePermissions([nodeId], 'read', sub, dominionOverHostAtSubscribe).allowed.size > 0` — a
 * COMPOUND gate (`dominionOverHostAtSubscribe || resolvePermission`). testing.md requires each
 * operand be exercised + mutation-checked independently. The filter is private to the plane, so
 * this drives it the way production does — a real scripted turn, whose progress streams under
 * `CHAT_NODE_ID` — with three subscribers on the chat query:
 *   - admin@example.com  → access.scopeAdmin, NO DAG grant → IN via the dominionOverHostAtSubscribe operand
 *                          (the Galaxy seeds no root admin, so the admin holds no grant on the root)
 *   - granted (non-admin) → explicit read grant on CHAT_NODE_ID → IN via the resolvePermission operand
 *   - denied  (non-admin) → no grant                           → OUT (the negative)
 *
 * Mutation-checks (run by the verifier / by hand against resources.ts `#targetsForQuery`):
 *   - force `.allowed.size > 0` always-true → `denied` receives a chunk → red
 *   - force `Boolean(r.dominionOverHostAtSubscribe)` → false → `admin` receives none → red
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { CHAT_NODE_ID, DEFAULT_CHAT_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { QueryDescriptor } from '@lumenize/nebula';
import { universeAdminClient, createInvitedClient, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueChatScope = () => `c3t-${crypto.randomUUID().slice(0, 8)}.app`;

/** A round that calls `build` (its step streams `building…`), then one that marks complete. */
const BUILD_THEN_COMPLETE = [
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'b1', type: 'function', function: { name: 'build', arguments: '{}' } },
  ] } }] },
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
  ] } }] },
];

  // ⚠️ `universeAdminClient`, not `adminClientAt`: chat lives at the GALAXY tier ({u}.{g})
  // post-collapse, and `adminClientAt` is star-tier only — the covering universe admin is how
  // a galaxy is administered.
function devClient(scope: string, email = 'admin@example.com') {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, email, CHAT_MESSAGE_ONTOLOGY_VERSION,
    { resourceHostBinding: 'GALAXY' },
  );
}

describe('child3 — a turn\'s chunks reach the readers of the chat node, and no one else', () => {
  it('reaches the dominionOverHostAtSubscribe-bypass + read-granted subscribers, not the read-denied one', async () => {
    const scope = uniqueChatScope();
    const { client: admin, accessToken } = await devClient(scope);
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
    const chatPair = { resourceHostBinding: 'GALAXY' } as const;

    // Non-admin "granted": explicit read on the chat node.
    const adminBrowser = new Browser();
    await createSubject(adminBrowser, scope, accessToken, 'granted@example.com');
    const { client: granted, payload: grantedP } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'granted@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    await admin.orgTree.setPermission(CHAT_NODE_ID, grantedP.sub, 'read');

    // Non-admin "denied": no grant anywhere.
    await createSubject(adminBrowser, scope, accessToken, 'denied@example.com');
    const { client: denied } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'denied@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);

    // All three subscribe the chat query → three query rows, each carrying its own sub +
    // dominionOverHostAtSubscribe flag. Permission is enforced per push, per target.
    using sa = admin.resources.subscribeQuery(query); await sa.ready;
    using sg = granted.resources.subscribeQuery(query); await sg.ready;
    using sd = denied.resources.subscribeQuery(query); await sd.ready;
    const deniedUpdates = denied.queryUpdateCount;

    admin.callGalaxyChatScripted(scope, 'build it', BUILD_THEN_COMPLETE);
    await vi.waitFor(() => expect(admin.streamChunkCount).toBeGreaterThanOrEqual(1));    // dominionOverHostAtSubscribe operand
    await vi.waitFor(() => expect(granted.streamChunkCount).toBeGreaterThanOrEqual(1));  // resolvePermission operand
    // A same-connection barrier before the negative: the turn's commit reaches `denied` as a
    // query update after every chunk was sent.
    await vi.waitFor(() => expect(denied.queryUpdateCount).toBeGreaterThan(deniedUpdates));
    expect(denied.streamChunkCount).toBe(0);                                              // neither → excluded

    admin[Symbol.dispose](); granted[Symbol.dispose](); denied[Symbol.dispose]();
  });
});
