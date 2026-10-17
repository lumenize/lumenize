/**
 * `lmz.broadcast` — the two examples in website/docs/mesh/broadcast.mdx, driven.
 *
 * One document, two live editors, and one subscriber whose tab closed long ago. That tab's host has
 * no socket and no grace period left for it, so it answers a push with `ClientDisconnectedError` at
 * once — the case drop-on-failed-fanout cleanup exists for. `publish` reaches both editors and
 * only logs the dead subscriber's failure, leaving it listed; `publishAndPrune` reaches them too,
 * and its `onResult` handler drops the dead one.
 */

import { it, expect, vi } from 'vitest';
import { Browser, createTestingClient, type RpcAccessible } from '@lumenize/testing';
import { EditorClient } from './editor-client.js';
import type { DocumentDO, Subscriber } from './document-do.js';
import { loginAt, uniqueScope, type Login } from '../../support/login.js';

type DocumentDOType = RpcAccessible<InstanceType<typeof DocumentDO>>;

/** An editor on its workspace's page, logged in through Mesh's Registry (ADR-009 rung 2). */
function connectEditor(login: Login): EditorClient {
  const browser = new Browser();
  return new EditorClient({
    instanceName: `${login.sub}.tab1`,
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });
}

it('broadcasts to every subscriber, and onResult drops the one whose tab is gone', async () => {
  const workspace = uniqueScope('acme');
  const documentId = crypto.randomUUID();
  const staleSub = crypto.randomUUID();
  const staleSubscriber = `${workspace}/${staleSub}.tab-closed-yesterday`;

  // ============================================
  // Setup: two editors open the document, and a long-gone tab is still listed
  // ============================================

  const aliceLogin = await loginAt(workspace);
  const bobLogin = await loginAt(workspace);
  using alice = connectEditor(aliceLogin);
  using bob = connectEditor(bobLogin);
  const aliceSaw: string[] = [];
  const bobSaw: string[] = [];
  await vi.waitFor(() => {
    expect(alice.connectionState).toBe('connected');
    expect(bob.connectionState).toBe('connected');
  });
  await alice.createDocument(documentId);
  await alice.shareDocument(documentId, bobLogin.sub);
  // Shared with the stale tab's user too, so only its missing socket keeps it from a push
  await alice.shareDocument(documentId, staleSub);
  alice.openDocument(documentId, { onContentUpdate: (content) => aliceSaw.push(content) });
  bob.openDocument(documentId, { onContentUpdate: (content) => bobSaw.push(content) });

  // Each subscribe answers with the current (empty) content once it has registered the editor.
  await vi.waitFor(() => {
    expect(aliceSaw).toEqual(['']);
    expect(bobSaw).toEqual(['']);
  });

  using docClient = createTestingClient<DocumentDOType>('DOCUMENT_DO', documentId);
  const subscribers = await docClient.ctx.storage.kv.get('subscribers') as Subscriber[];
  expect(subscribers).toHaveLength(2);
  subscribers.push({ bindingName: 'WORKSPACE_DO', instanceName: staleSubscriber, sub: staleSub });
  await docClient.ctx.storage.kv.put('subscribers', subscribers);

  const listed = async () => (await docClient.ctx.storage.kv.get('subscribers') as Subscriber[]).map((s) => s.instanceName);

  // ============================================
  // Basic usage: one continuation to every subscriber
  // ============================================

  alice.lmz.call('DOCUMENT_DO', documentId, alice.ctn<DocumentDO>().publish('first'),
    alice.ctn().handleCallFailed('publish'), { onErrorOnly: true });
  await vi.waitFor(() => {
    expect(aliceSaw).toEqual(['', 'first']);
    expect(bobSaw).toEqual(['', 'first']);
  });

  // `publish`'s handler only logs the stale tab's failed push, so it is still listed.
  expect(await listed()).toContain(staleSubscriber);

  // ============================================
  // Result handling: onResult drops the subscriber whose host reported it gone
  // ============================================

  alice.lmz.call('DOCUMENT_DO', documentId, alice.ctn<DocumentDO>().publishAndPrune('second'),
    alice.ctn().handleCallFailed('publish'), { onErrorOnly: true });
  await vi.waitFor(async () => {
    expect(aliceSaw).toEqual(['', 'first', 'second']);
    expect(bobSaw).toEqual(['', 'first', 'second']);
    expect(await listed()).not.toContain(staleSubscriber);
  });

  // The live editors keep their rows: only the failed target was dropped.
  expect((await listed()).sort()).toEqual([`${workspace}/${alice.lmz.instanceName}`, `${workspace}/${bob.lmz.instanceName}`].sort());
});
