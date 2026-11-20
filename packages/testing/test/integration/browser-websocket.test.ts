/**
 * Browser's WebSocket against a DO that installs its WebSocket handlers per instance — the Cloudflare
 * Agents SDK's pattern — the way a test of a real Agent drives it.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser, createTestingClient, type RpcAccessible } from '../../src/index';
import { InstanceHandlerDO } from './test-worker-and-dos';

type InstanceHandlerDOType = RpcAccessible<InstanceType<typeof InstanceHandlerDO>>;

describe('Browser WebSocket against per-instance DO handlers', () => {
  it("delivers a non-RPC message and the client's close to the DO's own handlers", async () => {
    using client = createTestingClient<InstanceHandlerDOType>('INSTANCE_HANDLER_DO', 'deliver');
    const ws = new (new Browser().WebSocket)('wss://example.com/instance-handler-do/deliver');
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.OPEN));

    ws.send('hello');
    await vi.waitFor(async () => expect(await client.messages()).toEqual(['hello']));

    ws.close(4000, 'done');
    await vi.waitFor(async () => expect(await client.closeCode()).toBe(4000));
  });

  it("dispatches the server's close once, with its code, and nothing after it", async () => {
    using client = createTestingClient<InstanceHandlerDOType>('INSTANCE_HANDLER_DO', 'refuse');
    const events: string[] = [];
    const ws = new (new Browser().WebSocket)('wss://example.com/instance-handler-do/refuse?close=1008');
    for (const type of ['open', 'message', 'error', 'close']) {
      ws.addEventListener(type, (e: any) => { events.push(type === 'close' ? `close ${e.code}` : type); });
    }
    await vi.waitFor(() => expect(events).toContain('close 1008'));

    // An absence has no event to wait for, so wait on a round trip to the same DO instead: any
    // event the socket still had queued is dispatched before the reply arrives.
    await client.messages();
    expect(events.slice(events.indexOf('close 1008'))).toEqual(['close 1008']);
  });
});
