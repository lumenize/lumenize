/**
 * Test mock of the ClientLike interface. Tracks calls so assertions can
 * inspect what the factory did. Each method has a programmable response.
 */
import type { ClientLike, TransactionOutcome } from '../src/types';

export class MockClient implements ClientLike {
  // Call log
  txns: Array<{ rt: string; rid: string; eTag: string; value: unknown; newETag: string }> = [];
  subscribes: Array<{ rt: string; rid: string }> = [];
  unsubscribes: Array<{ rt: string; rid: string }> = [];

  // Programmable responses
  txnResponder: (args: { rt: string; rid: string; eTag: string; value: unknown }) =>
    TransactionOutcome | Promise<TransactionOutcome> =
    () => ({ resolution: 'committed', eTag: 'auto-eTag-' + Math.random().toString(36).slice(2) });
  subscribeResponder: (rt: string, rid: string) =>
    Promise<{ value: unknown; meta: { eTag: string } } | null> =
    async () => ({ value: {}, meta: { eTag: 'initial-eTag' } });

  // Fanout / connection-state observers (factory registers via on*)
  #resourceUpdateHandler: ((rt: string, rid: string, snapshot: { value: unknown; meta: { eTag: string } } | null) => void) | null = null;
  #connectionStateHandler: ((state: string) => void) | null = null;

  async transaction(args: { rt: string; rid: string; eTag: string; value: unknown; newETag: string }): Promise<TransactionOutcome> {
    this.txns.push({ ...args });
    return await this.txnResponder(args);
  }

  async subscribe(rt: string, rid: string): Promise<{ value: unknown; meta: { eTag: string } } | null> {
    this.subscribes.push({ rt, rid });
    return await this.subscribeResponder(rt, rid);
  }

  unsubscribe(rt: string, rid: string): void {
    this.unsubscribes.push({ rt, rid });
  }

  onResourceUpdate(handler: (rt: string, rid: string, snapshot: { value: unknown; meta: { eTag: string } } | null) => void): void {
    this.#resourceUpdateHandler = handler;
  }

  onConnectionStateChange(handler: (state: string) => void): void {
    this.#connectionStateHandler = handler;
  }

  /** Test helper: simulate a server-side fanout push. */
  simulateFanout(rt: string, rid: string, snapshot: { value: unknown; meta: { eTag: string } } | null): void {
    this.#resourceUpdateHandler?.(rt, rid, snapshot);
  }

  /** Test helper: simulate a connection state change. */
  simulateConnectionState(state: string): void {
    this.#connectionStateHandler?.(state);
  }

  reset(): void {
    this.txns = [];
    this.subscribes = [];
    this.unsubscribes = [];
  }
}
