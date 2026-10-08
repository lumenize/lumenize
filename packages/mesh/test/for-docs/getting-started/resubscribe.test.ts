/**
 * The getting-started `EditorClient` re-subscribes its open documents when its host reports a loss,
 * as `getting-started.mdx` describes `onSubscriptionRequired`. The page's narrative test never loses
 * a subscription, so it never runs that method on an open document. The loss here is a host
 * restarted with no record of the Client, as after a crash.
 */
import { it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { EditorClient } from './editor-client.js';
import { loginAt, uniqueScope } from '../../support/login.js';

it('a reconnect the host reports as a loss re-subscribes an open document', async () => {
  const workspace = uniqueScope('acme');
  const login = await loginAt(workspace);
  const browser = new Browser();
  const ctx = browser.context(login.baseUrl);
  using client = new EditorClient({
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));

  const content: string[] = [];
  const documentId = crypto.randomUUID();
  await client.createDocument(documentId);
  const doc = client.openDocument(documentId, {
    onContentUpdate: (c) => content.push(c),
    onSpellFindings: () => {},
  });
  await vi.waitFor(() => expect(content).toEqual(['']));

  // The socket drops and its host restarts, with no record of this Client. A stub that saw the
  // abort stays broken, and nothing here uses it again.
  const host = env.WORKSPACE_DO.getByName(workspace);
  await runInDurableObject(host, (_instance: unknown, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) ws.close(4000, 'the network dropped');
    state.abort();
  }).catch(() => {});

  // MUTATION: empty `onSubscriptionRequired`'s loop, and the content never arrives again.
  await vi.waitFor(() => expect(content).toEqual(['', '']), { timeout: 10000 });
  doc.close();
}, 20_000);
