/**
 * Memory-backed BroadcastChannel mock for testing
 *
 * Simulates the BroadcastChannel Web API for testing cross-tab communication
 * patterns without a real browser. Messages are delivered asynchronously via
 * queueMicrotask(), matching real browser behavior.
 *
 * Instances are scoped to a shared registry — all channels with the same name
 * in the same registry can communicate, mirroring how real BroadcastChannels
 * are scoped per-origin.
 *
 * @internal
 */

/**
 * Registry that tracks all open BroadcastChannel instances by name.
 * Shared across all contexts from the same origin (same Browser instance).
 */
export type BroadcastChannelRegistry = Map<string, Set<BroadcastChannelMock>>;

/**
 * Creates a BroadcastChannel constructor bound to a specific registry.
 *
 * Each Browser context gets its own constructor that shares the registry
 * with all other contexts from the same origin, enabling cross-context
 * (cross-tab) messaging.
 */
export function createBroadcastChannelConstructor(
  registry: BroadcastChannelRegistry,
): typeof BroadcastChannel {
  return class BoundBroadcastChannel extends BroadcastChannelMock {
    constructor(name: string) {
      super(name, registry);
    }
  } as unknown as typeof BroadcastChannel;
}

/**
 * Memory-backed BroadcastChannel implementation
 *
 * Implements the essential BroadcastChannel interface:
 * - `postMessage(message)` — delivers to all other open channels with the same name
 * - `close()` — unregisters from the registry, stops receiving messages
 * - `onmessage` — handler called when a message is received
 * - `addEventListener('message', ...)` — EventTarget-based message handling
 *
 * Known limitations vs real BroadcastChannel:
 * - No structured clone of messages (passes references directly)
 * - No MessageEvent origin/source fields
 * - No 'messageerror' event
 */
export class BroadcastChannelMock extends EventTarget {
  readonly name: string;
  #registry: BroadcastChannelRegistry;
  #closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor(name: string, registry: BroadcastChannelRegistry) {
    super();
    this.name = name;
    this.#registry = registry;

    // Register this channel
    let channels = this.#registry.get(name);
    if (!channels) {
      channels = new Set();
      this.#registry.set(name, channels);
    }
    channels.add(this);
  }

  /**
   * Send a message to all other open channels with the same name.
   * Messages are delivered asynchronously via queueMicrotask().
   * The posting instance does NOT receive its own message.
   */
  postMessage(message: unknown): void {
    if (this.#closed) {
      throw new DOMException(
        'Failed to execute \'postMessage\' on \'BroadcastChannel\': Channel is closed',
        'InvalidStateError',
      );
    }

    const channels = this.#registry.get(this.name);
    if (!channels) return;

    // Deliver to all OTHER channels with the same name (not self)
    for (const channel of channels) {
      if (channel === this) continue;
      if (channel.#closed) continue;

      // Async delivery via queueMicrotask — matches real browser behavior
      queueMicrotask(() => {
        if (channel.#closed) return; // Re-check after microtask

        const event = new MessageEvent('message', { data: message });

        // Call onmessage handler if set
        channel.onmessage?.(event);

        // Also dispatch to addEventListener handlers
        channel.dispatchEvent(event);
      });
    }
  }

  /**
   * Close this channel. Stops receiving messages and unregisters from the registry.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    const channels = this.#registry.get(this.name);
    if (channels) {
      channels.delete(this);
      if (channels.size === 0) {
        this.#registry.delete(this.name);
      }
    }
  }
}
