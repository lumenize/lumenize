/**
 * A pushed call hands a client the writer's `originAuth`, never its `originRequest`.
 *
 * `originRequest` is what the Gateway snapshots from a client's WebSocket upgrade: its IP,
 * `User-Agent`, `Accept-Language`, and Cloudflare's `cf` city, region, latitude, longitude,
 * timezone and colo. Server-side code reads it anywhere along the chain — an emailed link is built
 * from its `origin`. But a push that keeps the writer's chain, which is what `svc.broadcast` sends,
 * used to carry it into every subscriber's socket, so each subscriber received the WRITER's
 * location and browser on every write. `originAuth` still reaches the client on purpose:
 * `LumenizeClient.onBeforeCall` authorizes an incoming call from it.
 *
 * A subscriber could read the field in two places, so there are two limbs:
 * - **`this.lmz.callContext` in the subscriber's `@mesh()` handler** — what app code sees, decided
 *   by the client's `#handleIncomingCall`.
 * - **the raw `incoming_call` frame on the subscriber's socket** — what devtools shows, decided by
 *   the Gateway's `#forwardToClient`. This is the limb that reds if the Gateway starts forwarding
 *   the field again: the client no longer copies it, so the handler limb stays green through that
 *   regression.
 *
 * **Why no running system (`live.md`).** Both deciding functions are mesh code that reads nothing
 * from its environment, and this drives them end to end: real `EditorClient`s over real WebSocket
 * upgrades, the Worker, `@lumenize/auth`'s hooks, the base `LumenizeClientGateway` and a real
 * `DocumentDO`. The `originRequest` in play is the one the Gateway stamped from the writer's own
 * upgrade; nothing here builds it. A deployed Worker changes what the snapshot contains (a real
 * `cf`, an edge-set IP), never whether it is forwarded. And this lane runs in CI, so a mesh change
 * that forwards the field again is caught where it is made, which `/live` is not.
 */
import { it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { createTestRefreshFunction, GatewayMessageType, type CallContext } from '../../../src/index.js';
import { EditorClient } from './editor-client.js';
import type { DocumentDO } from './document-do.js';

/**
 * A connected `EditorClient` for `sub`. Pass `frames` to record every text frame its socket
 * receives — the recorder subclasses the WebSocket, so it sits below the client's own parsing.
 */
async function connectEditor(sub: string, frames?: string[]): Promise<EditorClient> {
  const browser = new Browser();
  class RecordingWebSocket extends browser.WebSocket {
    constructor(url: string | URL, protocols?: string[] | string) {
      super(url, protocols);
      this.addEventListener('message', (event) => {
        if (typeof event.data === 'string') frames?.push(event.data);
      });
    }
  }
  const client = new EditorClient({
    instanceName: `${sub}.tab1`,
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction({ sub }),
    fetch: browser.fetch,
    WebSocket: RecordingWebSocket,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

it("a subscriber receives the writer's originAuth, never its originRequest", async () => {
  const writerSub = crypto.randomUUID();
  const subscriberFrames: string[] = [];
  using writer = await connectEditor(writerSub);
  using subscriber = await connectEditor(crypto.randomUUID(), subscriberFrames);
  const documentId = crypto.randomUUID();

  const contents: string[] = [];
  const contexts: CallContext[] = [];
  subscriber.openDocument(documentId, {
    onContentUpdate: (c) => contents.push(c),
    onContentUpdateContext: (ctx) => contexts.push(ctx),
  });
  await vi.waitFor(() => expect(contents[0]).toBe(''), { timeout: 10000 }); // subscribed

  // The push that keeps the WRITER's chain (no `newChain`) — the shape `svc.broadcast` sends.
  writer.lmz.call('DOCUMENT_DO', documentId,
    writer.ctn<DocumentDO>().updatePreservingOrigin('hello from writer'));
  await vi.waitFor(() => expect(contents).toContain('hello from writer'), { timeout: 10000 });

  // ── Handler limb: `this.lmz.callContext`, as the subscriber's @mesh() handler read it ──
  expect(contexts).toHaveLength(1);
  const [ctx] = contexts;
  // Positive control: this is the writer's chain. `originRequest` is copied beside `originAuth`
  // by the same spread at every hop, so it rode this push as far as the Gateway.
  expect(ctx.callChain[0]).toMatchObject({ type: 'LumenizeClient', instanceName: `${writerSub}.tab1` });
  // MUTATION-CHECK (run, flipped): drop `originAuth` from `#forwardToClient` and this reds.
  expect(ctx.originAuth?.sub).toBe(writerSub);
  // Red before the fix: the subscriber's handler saw the writer's `{ origin: 'https://localhost' }`.
  expect(ctx.originRequest).toBeUndefined();

  // ── Wire limb: the raw frame the Gateway put on the subscriber's socket ──
  const pushes = subscriberFrames
    .map((raw) => ({ raw, message: JSON.parse(raw) }))
    .filter(({ message }) => message.type === GatewayMessageType.INCOMING_CALL);
  expect(pushes).toHaveLength(1);
  const [push] = pushes;
  expect(push.message.callContext.originAuth.sub).toBe(writerSub);
  // MUTATION-CHECK (run, flipped): forward `originRequest` from `#forwardToClient` again and this
  // reds while the handler limb above stays green. The client-side copy has no runtime check:
  // `IncomingCallMessage` has no such field, so restoring it fails the type-check instead.
  expect(push.message.callContext).not.toHaveProperty('originRequest');
  // On the bytes, so a copy anywhere else in the frame reds too. MUTATION-CHECK (run, flipped):
  // smuggle it inside `state` and only this line reds.
  expect(push.raw).not.toContain('"originRequest"');
}, 20000);
