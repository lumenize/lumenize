/**
 * A document node is its own gatekeeper. It is named by an id, never by a scope, so no tenant's
 * passage reaches it, and its owner shares it by `sub`, across organizations: a document owned at
 * acme reaches a user at globex. It checks the share list on `subscribe`, and again before each push.
 *
 * Every user logs in on their own organization's page through Mesh's Registry (ADR-009 rung 2).
 */
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { EditorClient } from './editor-client.js';
import { loginAt, uniqueScope, type Login } from '../../support/login.js';

/** A connected `EditorClient` for `login`, on its organization's page. */
async function editorFor(login: Login): Promise<EditorClient> {
  const browser = new Browser();
  const ctx = browser.context(login.baseUrl);
  const client = new EditorClient({
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

let entries: DebugLogOutput[] = [];
beforeEach(() => {
  entries = [];
  setDebugSink((e) => entries.push(e));
});
afterEach(() => clearDebugSink());

it('refuses a subscribe from a user the document was never shared with', async () => {
  const aliceLogin = await loginAt(uniqueScope('acme'));
  const carolLogin = await loginAt(uniqueScope('globex'));
  using alice = await editorFor(aliceLogin);
  using carol = await editorFor(carolLogin);
  const documentId = crypto.randomUUID();
  await alice.createDocument(documentId);
  alice.openDocument(documentId, {});

  const content: string[] = [];
  const refusals: Error[] = [];
  carol.openDocument(documentId, { onContentUpdate: (c) => content.push(c), onSubscribeRefused: (e) => refusals.push(e) });

  // MUTATION: drop the guard on `subscribe`, and Carol gets the content instead.
  await vi.waitFor(() => expect(refusals).toHaveLength(1));
  expect(refusals[0].message).toBe(`Not shared with ${carolLogin.sub}`);
  expect(content).toEqual([]);
}, 20_000);

it('pushes to a user at another organization it is shared with, and stops once it is unshared', async () => {
  const aliceLogin = await loginAt(uniqueScope('acme'));
  const bobLogin = await loginAt(uniqueScope('globex'));
  using alice = await editorFor(aliceLogin);
  using bob = await editorFor(bobLogin);
  const documentId = crypto.randomUUID();
  await alice.createDocument(documentId);
  const aliceContent: string[] = [];
  const aliceDoc = alice.openDocument(documentId, { onContentUpdate: (c) => aliceContent.push(c) });
  await vi.waitFor(() => expect(aliceContent).toEqual(['']));

  await alice.shareDocument(documentId, bobLogin.sub);
  const bobContent: string[] = [];
  bob.openDocument(documentId, { onContentUpdate: (c) => bobContent.push(c) });
  await vi.waitFor(() => expect(bobContent).toEqual(['']));

  aliceDoc.saveContent('first draft');
  await vi.waitFor(() => expect(bobContent).toEqual(['', 'first draft']));

  // Unshared while still subscribed: the next push is withheld from Bob, and Alice's own push is
  // the barrier, sent in the same broadcast.
  await alice.unshareDocument(documentId, bobLogin.sub);
  aliceDoc.saveContent('second draft');
  await vi.waitFor(() => expect(aliceContent.at(-1)).toBe('second draft'));

  // MUTATION: skip the share-list check before the push, and Bob receives the second draft.
  expect(bobContent).toEqual(['', 'first draft']);
  const withheld = entries.filter((e) => e.message === 'push withheld');
  expect(withheld.map((e) => e.data?.refusal)).toEqual([`Not shared with ${bobLogin.sub}`]);
}, 20_000);
