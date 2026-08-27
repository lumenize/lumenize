/**
 * Galaxy resource data-plane — real-NebulaClient e2e (Child 1; host re-homed by the collapse).
 *
 * A `NebulaClient` configured `resourceHostBinding: 'GALAXY'` hosts the chat
 * `Chat`/`Message` Resources on the **Galaxy** DO — exercised through the **public**
 * API (`client.resources.*` / `client.orgTree.*`) over the full integration path
 * (real JWTs minted locally + verified normally — NOT a test-mode bypass):
 *   - CRUD + the ADR-006 `Message.chat` FK in one atomic transaction (client UUIDs);
 *   - single-resource subscribe + fanout PUSH to a *second* subscriber client;
 *   - DAG permission: a non-granted subject is denied, a granted one allowed (SC2);
 *   - the UNIFORMITY GATE: the Galaxy ENFORCES its INSTALLED chat-ontology version —
 *     a client sending the old arbitrary string ("studio-ui"-style) gets
 *     `OntologyStaleError`, and the snapshot's version is server-stamped.
 *
 * The chat ontology self-seeds as an INSTALLED version on first touch; no apply step.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient, createInvitedClient, browserLogin, foundAndLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

// Chat lives on the Galaxy at the `{u}.{g}` tier (the collapse).
const uniqueChatScope = () => `acme-${crypto.randomUUID().slice(0, 8)}.app`;

// Admin (scope-admin) client bound to GALAXY, sending the REAL installed chat-ontology
// version (the uniformity gate: the host enforces it).
// ⚠️ `universeAdminClient`, not `adminClientAt`: chat lives at the GALAXY tier ({u}.{g})
// post-collapse, and `adminClientAt` is star-tier only — the covering universe admin is how
// a galaxy is administered.
function devAdmin(scope: string, ontologyVersion = CHAT_MESSAGE_ONTOLOGY_VERSION) {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', ontologyVersion,
    { resourceHostBinding: 'GALAXY' },
  );
}

describe('Galaxy resources e2e (real NebulaClient, resourceHostBinding: GALAXY)', () => {
  it('UNIFORMITY GATE: an arbitrary "studio-ui"-style version gets OntologyStaleError; the REAL version works and is server-stamped', async () => {
    const scope = uniqueChatScope();
    // The OLD arbitrary-string behavior ("studio-ui" / "harness-v0") must now be REFUSED —
    // the Galaxy enforces its installed version. Capable-of-failing: restore `void
    // ontologyVersion` on the host → this read succeeds → red.
    const { client: wrong } = await devAdmin(scope, 'studio-ui');
    await expect(wrong.resources.read('Message', crypto.randomUUID())).rejects.toThrow(/Ontology version mismatch/);
    wrong[Symbol.dispose]();

    const { client } = await devAdmin(scope);
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const out = await client.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'chat 1' } },
      [messageId]: { op: 'create', typeName: 'Message', nodeId: ROOT_NODE_ID, value: { chat: chatId, content: 'hello' } },
    });
    expect(out.kind).toBe('committed');

    const message = await client.resources.read('Message', messageId) as Snapshot;
    expect((message.value as { chat: string }).chat).toBe(chatId); // ADR-006 by-id FK
    expect((message.value as { content: string }).content).toBe('hello');
    // Stamped with the SERVER's installed version.
    expect(message.meta.ontologyVersion).toBe(CHAT_MESSAGE_ONTOLOGY_VERSION);

    const chat = await client.resources.read('Chat', chatId) as Snapshot;
    expect((chat.value as { title: string }).title).toBe('chat 1');

    client[Symbol.dispose]();
  });

  it('fans a Message mutation out to a SECOND subscriber client (push to other subscribers)', async () => {
    const scope = uniqueChatScope();
    const { client: a } = await devAdmin(scope);
    // Distinct Browser ⇒ distinct Gateway ⇒ distinct clientId (the fanout is keyed
    // on clientId, so b's put fans out to a, the non-originator subscriber).
    const { client: b } = await devAdmin(scope);
    const turnId = crypto.randomUUID();

    using sub = a.resources.createAndSubscribe('Message', turnId, ROOT_NODE_ID, { chat: 'chat-x', content: 'v1' });
    const created = await sub.snapshot;
    expect(created).not.toBeNull();
    const eTag = created!.meta.eTag;

    const baseline = a.resourceUpdateCount;
    const out = await b.resources.transaction({
      [turnId]: { op: 'put', typeName: 'Message', eTag, value: { chat: 'chat-x', content: 'v2-from-b' } },
    });
    expect(out.kind).toBe('committed');

    // a (the OTHER subscriber) receives b's mutation via fanout.
    await vi.waitFor(() => {
      expect(a.resourceUpdateCount).toBeGreaterThan(baseline);
      expect((a.lastResourceUpdate?.snapshot?.value as { content?: string } | undefined)?.content).toBe('v2-from-b');
    });

    a[Symbol.dispose]();
    b[Symbol.dispose]();
  });

  it('DAG permission: a non-granted subject is denied; granting write lets them in (SC2)', async () => {
    const scope = uniqueChatScope();
    const { client: admin, accessToken } = await devAdmin(scope);

    // Admin (scope-admin bypass) makes a private node + a Message on it.
    const nodeId = await admin.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'private', 'Private');
    const existingTurn = crypto.randomUUID();
    const seed = await admin.resources.transaction({
      [existingTurn]: { op: 'create', typeName: 'Message', nodeId, value: { chat: 'chat-x', content: 'secret' } },
    });
    expect(seed.kind).toBe('committed');

    // A non-admin subject at the same {u}.{g}.dev scope (real signup; no grant yet).
    const adminBrowser = new Browser();
    await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'coach@example.com');
    const { client: user, payload } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'coach@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
      { resourceHostBinding: 'GALAXY' },
    );

    // DENIED: read the existing Message (exists but no grant) → rejects with permission.
    await expect(user.resources.read('Message', existingTurn)).rejects.toThrow(/permission/i);
    // DENIED: write a new Message on the node → per-resource permission-denied.
    const denied = await user.resources.transaction({
      [crypto.randomUUID()]: { op: 'create', typeName: 'Message', nodeId, value: { chat: 'chat-x', content: 'nope' } },
    });
    expect(denied.kind).toBe('rejected');
    expect(denied.kind === 'rejected' && denied.resources[Object.keys(denied.resources)[0]]?.kind).toBe('permission-denied');

    // GRANT write to the user, then they CAN create + read on the node.
    await admin.orgTree.setPermission(nodeId, payload.sub, 'write');
    const myTurn = crypto.randomUUID();
    const allowed = await user.resources.transaction({
      [myTurn]: { op: 'create', typeName: 'Message', nodeId, value: { chat: 'chat-x', content: 'mine' } },
    });
    expect(allowed.kind).toBe('committed');
    const back = await user.resources.read('Message', myTurn) as Snapshot;
    expect((back.value as { content: string }).content).toBe('mine');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });
});
