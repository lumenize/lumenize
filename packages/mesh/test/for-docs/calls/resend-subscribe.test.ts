/**
 * `EditorClient` restores what a reconnect may have lost, as `lumenize-client.mdx` teaches it.
 *
 * - **A reconnect the host reports as a loss runs `onSubscriptionRequired`**, which re-subscribes
 *   every open document. The loss here is a host restarted with no record of the Client, as after
 *   a crash: a missed answer needs the 30 s call timeout to run out, which this project keeps.
 * - **A subscribe sent just as a socket closes is sent again on the reconnect.** A reconnect inside
 *   the grace period does not run `onSubscriptionRequired`, so a subscribe whose frame never reached
 *   the host would have no answer, ever. The Client's `WebSocket` drops the subscribe's frame and
 *   its host then closes the socket, which is what a socket dying under a just-sent frame looks
 *   like.
 *
 * Each user logs in on its workspace's page through Mesh's Registry (ADR-009 rung 2).
 */
import { it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { EditorClient } from './editor-client.js';
import { loginAt, uniqueScope } from '../../support/login.js';

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
  const workspace = uniqueScope('acme');
  const login = await loginAt(workspace);
  const browser = new Browser();
  const Dropping = droppingNextCall(browser.WebSocket);
  using editor = new EditorClient({
    instanceName: `${login.sub}.tab1`,
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: Dropping,
  });
  await vi.waitFor(() => expect(editor.connectionState).toBe('connected'), { timeout: 10000 });
  const documentId = crypto.randomUUID();
  await editor.createDocument(documentId);

  const seen: string[] = [];
  Dropping.armed = true;
  editor.openDocument(documentId, { onContentUpdate: (content) => seen.push(content) });
  await vi.waitFor(() => expect(Dropping.armed).toBe(false)); // the frame was lost
  const host = env.WORKSPACE_DO.getByName(workspace);
  await runInDurableObject(host, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets(`${workspace}/${login.sub}.tab1`)) ws.close(4000, 'the socket died under the frame');
  });

  // MUTATION: drop the re-send on reconnect, and the snapshot never arrives.
  await vi.waitFor(() => expect(seen).toEqual(['']), { timeout: 10000 });
}, 20_000);

it('a reconnect the host reports as a loss re-subscribes an open document', async () => {
  const workspace = uniqueScope('acme');
  const login = await loginAt(workspace);
  const browser = new Browser();
  using editor = new EditorClient({
    instanceName: `${login.sub}.tab1`,
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });
  await vi.waitFor(() => expect(editor.connectionState).toBe('connected'), { timeout: 10000 });
  const documentId = crypto.randomUUID();
  await editor.createDocument(documentId);

  const seen: string[] = [];
  editor.openDocument(documentId, { onContentUpdate: (content) => seen.push(content) });
  await vi.waitFor(() => expect(seen).toEqual(['']), { timeout: 10000 });

  // The socket drops and its host restarts, with no record of this Client. A stub that saw the
  // abort stays broken, and nothing here uses it again.
  const host = env.WORKSPACE_DO.getByName(workspace);
  await runInDurableObject(host, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets()) ws.close(4000, 'the network dropped');
    ctx.abort();
  }).catch(() => {});

  // MUTATION: empty `onSubscriptionRequired`'s loop, and no second snapshot arrives.
  await vi.waitFor(() => expect(seen).toEqual(['', '']), { timeout: 10000 });
}, 20_000);
