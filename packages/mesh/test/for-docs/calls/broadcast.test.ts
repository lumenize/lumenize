/**
 * `lmz.broadcast` — the two examples in website/docs/mesh/broadcast.mdx, driven.
 *
 * One document, two live editors, and one subscriber whose tab closed long ago. That tab's Gateway
 * has no socket and no grace period left, so it answers a push with `ClientDisconnectedError` at
 * once — the case drop-on-failed-fanout cleanup exists for. `publish` reaches both editors and
 * leaves the dead subscriber listed; `publishAndPrune` reaches them too, and its `onResult` handler
 * drops the dead one.
 */

import { it, expect, vi } from 'vitest';
import { Browser, createTestingClient, type RpcAccessible } from '@lumenize/testing';
import { createTestRefreshFunction } from '../../../src/index.js';
import { EditorClient } from './editor-client.js';
import type { DocumentDO } from './document-do.js';

type DocumentDOType = RpcAccessible<InstanceType<typeof DocumentDO>>;

function connectEditor(): EditorClient {
  const userId = crypto.randomUUID();
  const browser = new Browser();
  return new EditorClient({
    instanceName: `${userId}.tab1`,
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction({ sub: userId }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });
}

it('broadcasts to every subscriber, and onResult drops the one whose tab is gone', async () => {
  const documentId = `broadcast-doc-${crypto.randomUUID()}`;
  const staleSubscriber = `${crypto.randomUUID()}.tab-closed-yesterday`;

  // ============================================
  // Setup: two editors open the document, and a long-gone tab is still listed
  // ============================================

  using alice = connectEditor();
  using bob = connectEditor();
  const aliceSaw: string[] = [];
  const bobSaw: string[] = [];
  await vi.waitFor(() => {
    expect(alice.connectionState).toBe('connected');
    expect(bob.connectionState).toBe('connected');
  });
  alice.openDocument(documentId, { onContentUpdate: (content) => aliceSaw.push(content) });
  bob.openDocument(documentId, { onContentUpdate: (content) => bobSaw.push(content) });

  // Each subscribe answers with the current (empty) content once it has registered the editor.
  await vi.waitFor(() => {
    expect(aliceSaw).toEqual(['']);
    expect(bobSaw).toEqual(['']);
  });

  using docClient = createTestingClient<DocumentDOType>('DOCUMENT_DO', documentId);
  const subscribers = await docClient.ctx.storage.kv.get('subscribers') as Set<string>;
  expect(subscribers.size).toBe(2);
  subscribers.add(staleSubscriber);
  await docClient.ctx.storage.kv.put('subscribers', subscribers);

  const listed = async () => [...(await docClient.ctx.storage.kv.get('subscribers') as Set<string>)];

  // ============================================
  // Basic usage: one continuation to every subscriber
  // ============================================

  alice.lmz.call('DOCUMENT_DO', documentId, alice.ctn<DocumentDO>().publish('first'));
  await vi.waitFor(() => {
    expect(aliceSaw).toEqual(['', 'first']);
    expect(bobSaw).toEqual(['', 'first']);
  });

  // Nothing heard that the stale tab's push failed, so it is still listed.
  expect(await listed()).toContain(staleSubscriber);

  // ============================================
  // Result handling: onResult drops the subscriber whose Gateway reported it gone
  // ============================================

  alice.lmz.call('DOCUMENT_DO', documentId, alice.ctn<DocumentDO>().publishAndPrune('second'));
  await vi.waitFor(async () => {
    expect(aliceSaw).toEqual(['', 'first', 'second']);
    expect(bobSaw).toEqual(['', 'first', 'second']);
    expect(await listed()).not.toContain(staleSubscriber);
  });

  // The live editors keep their rows: only the failed target was dropped.
  expect((await listed()).sort()).toEqual([alice.lmz.instanceName, bob.lmz.instanceName].sort());
});
