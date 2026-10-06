/**
 * `EditorClient` restores what a reconnect may have lost, as `lumenize-client.mdx` teaches it.
 *
 * - **A reconnect the Gateway reports as a loss runs `onSubscriptionRequired`**, which re-subscribes
 *   every open document. The loss here is a Gateway restarted with no record of the Client, as
 *   after a crash: a missed answer needs the 30 s call timeout to run out, which this project
 *   keeps.
 * - **A subscribe sent just as a socket closes is sent again on the reconnect.** A reconnect inside
 *   the grace period does not run `onSubscriptionRequired`, so a subscribe whose frame never reached
 *   the Gateway would have no answer, ever. The Client's `WebSocket` drops the subscribe's frame and
 *   its Gateway then closes the socket, which is what a socket dying under a just-sent frame looks
 *   like.
 */
import { it, expect, vi } from 'vitest';
// Also what lets `Browser`'s default fetch reach the test Worker through `SELF`.
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { createTestRefreshFunction } from '../../../src/index.js';
import { EditorClient } from './editor-client.js';

/** A WebSocket that, once armed, swallows the next `call` frame. */
function droppingNextCall(Base: typeof WebSocket): typeof WebSocket & { armed: boolean } {
  return class extends Base {
    static armed = false;
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const ctor = this.constructor as unknown as { armed: boolean };
      if (ctor.armed && typeof data === 'string' && JSON.parse(data).type === 'call') {
        ctor.armed = false;
        return;
      }
      super.send(data);
    }
  } as never;
}

it('a subscribe whose frame was lost with its socket gets its snapshot after the reconnect', async () => {
  const browser = new Browser();
  const Dropping = droppingNextCall(browser.WebSocket);
  const sub = crypto.randomUUID();
  using editor = new EditorClient({
    instanceName: `${sub}.tab1`,
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction({ sub }),
    fetch: browser.fetch,
    WebSocket: Dropping,
  });
  await vi.waitFor(() => expect(editor.connectionState).toBe('connected'), { timeout: 10000 });

  const seen: string[] = [];
  Dropping.armed = true;
  editor.openDocument(`resend-${sub}`, { onContentUpdate: (content) => seen.push(content) });
  await vi.waitFor(() => expect(Dropping.armed).toBe(false)); // the frame was lost
  const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(`${sub}.tab1`));
  await runInDurableObject(gateway, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets()) ws.close(4000, 'the socket died under the frame');
  });

  // MUTATION: drop the re-send on reconnect, and the snapshot never arrives.
  await vi.waitFor(() => expect(seen).toEqual(['']), { timeout: 10000 });
}, 20_000);

it('a reconnect the Gateway reports as a loss re-subscribes an open document', async () => {
  const browser = new Browser();
  const sub = crypto.randomUUID();
  using editor = new EditorClient({
    instanceName: `${sub}.tab1`,
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction({ sub }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });
  await vi.waitFor(() => expect(editor.connectionState).toBe('connected'), { timeout: 10000 });

  const seen: string[] = [];
  editor.openDocument(`resubscribe-${sub}`, { onContentUpdate: (content) => seen.push(content) });
  await vi.waitFor(() => expect(seen).toEqual(['']), { timeout: 10000 });

  // The socket drops and its Gateway restarts, with no record of this Client. A stub that saw the
  // abort stays broken, and nothing here uses it again.
  const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(`${sub}.tab1`));
  await runInDurableObject(gateway, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets()) ws.close(4000, 'the network dropped');
    ctx.abort();
  }).catch(() => {});

  // MUTATION: empty `onSubscriptionRequired`'s loop, and no second snapshot arrives.
  await vi.waitFor(() => expect(seen).toEqual(['', '']), { timeout: 10000 });
}, 20_000);
