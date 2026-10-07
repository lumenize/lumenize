/**
 * A Client stopped on purpose stays stopped when the tab wakes: one whose host closed its socket with
 * 4410, and one its own app disconnected. A Client that lost its socket for any other reason
 * reconnects on the same event, which is the positive control.
 *
 * In a real browser rather than the Node lane, because wake-up sensing listens on `document` and
 * `window`, which Node lacks, so the Node lane never installs it. The sockets are scripted rather
 * than real: what is under test is how the Client answers a close code and a wake-up event, and a
 * scripted socket can hand it 4410 without a node to delete.
 */
import { describe, it, expect, vi } from 'vitest';
import { LumenizeClient, WS_CLOSE_GONE } from '../../src/client-index.js';

/** A WebSocket the test opens and closes by hand, recording every one the Clients construct. */
function scriptedSockets() {
  const made: ScriptedSocket[] = [];
  class ScriptedSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = ScriptedSocket.CONNECTING;
    protocol = '';
    onopen: ((e: unknown) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor(public url: string, public protocols?: string | string[]) {
      made.push(this);
    }
    open(): void {
      this.readyState = ScriptedSocket.OPEN;
      this.protocol = 'lmz.2';
      this.onopen?.({});
    }
    drop(code: number, reason = ''): void {
      this.readyState = ScriptedSocket.CLOSED;
      this.onclose?.({ code, reason });
    }
    send(): void {}
    close(): void {
      this.readyState = ScriptedSocket.CLOSED;
    }
  }
  return { made, WebSocket: ScriptedSocket as unknown as typeof WebSocket };
}

/** `LumenizeClient` is abstract; this one adds nothing. */
class WakeClient extends LumenizeClient {}

describe('wake-up sensing', () => {
  it('reconnects a dropped Client and leaves a deleted host\'s Client and a disconnected one stopped', async () => {
    const sockets = scriptedSockets();
    // A structurally valid token, unexpired, so the Client opens its socket without a refresh.
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc({ sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 900 })}.sig`;
    const client = (name: string, onHostDeleted?: (e: Error) => void) => new WakeClient({
      baseUrl: 'http://localhost',
      instanceName: `user-123.${name}`,
      accessToken: jwt,
      refresh: async () => ({ access_token: jwt, sub: 'user-123' }),
      WebSocket: sockets.WebSocket,
      onHostDeleted,
    });
    const told: string[] = [];
    const deleted = client('deleted', (e) => told.push(e.name));
    const dropped = client('dropped');
    const stopped = client('stopped');
    await vi.waitFor(() => expect(sockets.made).toHaveLength(3));
    const [deletedSocket, droppedSocket] = sockets.made;
    for (const s of sockets.made) (s as unknown as { open(): void }).open();

    (deletedSocket as unknown as { drop(code: number, reason: string): void }).drop(WS_CLOSE_GONE, 'Scope deleted');
    (droppedSocket as unknown as { drop(code: number): void }).drop(1006);
    stopped.disconnect();
    expect(told).toEqual(['HostDeletedError']);
    expect(deleted.connectionState).toBe('disconnected');
    expect(stopped.connectionState).toBe('disconnected');

    // `online` reconnects at once, without the backoff the drop scheduled.
    window.dispatchEvent(new Event('online'));
    // The dropped Client's new socket is the barrier: the event reached every Client by the time it
    // exists, so a reconnect by either of the others would have constructed one too.
    await vi.waitFor(() => expect(sockets.made.length).toBeGreaterThan(3));
    expect(sockets.made.map((s) => (s as unknown as { url: string }).url).slice(3))
      .toEqual([expect.stringContaining('user-123.dropped')]);
    expect(deleted.connectionState).toBe('disconnected');
    expect(stopped.connectionState).toBe('disconnected');

    for (const c of [deleted, dropped, stopped]) c.disconnect();
  });
});
