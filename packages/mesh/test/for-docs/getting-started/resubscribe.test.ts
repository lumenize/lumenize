/**
 * The getting-started `EditorClient` re-subscribes its open documents when the Gateway reports a
 * loss, as `getting-started.mdx` describes `onSubscriptionRequired`. The page's narrative test
 * never loses a subscription, so it never runs that method on an open document. The loss here is a
 * Gateway restarted with no record of the Client, as after a crash.
 */
import { it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { createTestRefreshFunction } from '../../../src/index.js';
import { EditorClient } from './editor-client.js';

it('a reconnect the Gateway reports as a loss re-subscribes an open document', async () => {
  const browser = new Browser();
  const ctx = browser.context('https://localhost');
  using client = new EditorClient({
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction(),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));

  const content: string[] = [];
  const doc = client.openDocument(`resubscribe-${crypto.randomUUID()}`, {
    onContentUpdate: (c) => content.push(c),
    onSpellFindings: () => {},
  });
  await vi.waitFor(() => expect(content).toEqual(['']));

  // The socket drops and its Gateway restarts, with no record of this Client. A stub that saw the
  // abort stays broken, and nothing here uses it again.
  const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(client.lmz.instanceName!));
  await runInDurableObject(gateway, (_instance: unknown, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) ws.close(4000, 'the network dropped');
    state.abort();
  }).catch(() => {});

  // MUTATION: empty `onSubscriptionRequired`'s loop, and the content never arrives again.
  await vi.waitFor(() => expect(content).toEqual(['', '']), { timeout: 10000 });
  doc.close();
}, 20_000);
