type WSData = string | ArrayBuffer | Blob | Uint8Array;

interface InternalInit {
  url: string;
  protocols?: string | string[];
  headers?: Record<string, string>;
  maxQueueBytes?: number;
}

/**
 * Configuration options for creating a WebSocket shim factory.
 */
export interface FactoryInit {
  /** Optional headers to include in the WebSocket upgrade request (e.g., for authentication). */
  headers?: Record<string, string>;
  /** Optional maximum number of bytes that can be queued while in CONNECTING state. Defaults to unlimited. */
  maxQueueBytes?: number;
}

/**
 * Creates a WebSocket shim class for use in Cloudflare Workers test environments.
 * 
 * Returns a browser-compatible WebSocket constructor that uses a provided fetch function to initiate
 * WebSocket connections, enabling testing without a separate server.
 * 
 * @param fetchFn - The fetch function to use for WebSocket upgrade requests (e.g., `SELF.fetch.bind(SELF)`).
 * @param factoryInit - Optional configuration for headers and queue limits.
 * @returns A WebSocket-compatible constructor class.
 */
export function getWebSocketShim(fetchFn: typeof fetch, factoryInit?: FactoryInit): new (url: string, protocols?: string | string[]) => WebSocket {
  class WebSocketShim extends EventTarget {
    // Ready state constants (match browser WebSocket)
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    protocol = "";     // set after accept() if server selected one
    extensions = "";   // CF workers test sockets typically don't expose extensions
    binaryType: 'blob' | 'arraybuffer' = 'blob';

    // Handler properties for parity
    onopen: ((ev: Event) => any) | null = null;
    onmessage: ((ev: MessageEvent) => any) | null = null;
    onerror: ((ev: Event) => any) | null = null;
    onclose: ((ev: CloseEvent) => any) | null = null;

    // ---- state & internals (JavaScript private fields) ----
    #ws?: WebSocket;           // the accepted raw socket
    #stateOverride: number | null = WebSocketShim.CONNECTING;
    #queue: WSData[] = [];
    #queuedBytes = 0;
    #maxQueueBytes: number;
    #flushing = false;

    // Overloaded constructor to match browser WebSocket API
    constructor(url: string, protocols?: string | string[]) {
      super();

      // Merge factory init with constructor params
      const init: InternalInit = {
        url,
        protocols,
        headers: factoryInit?.headers,
        maxQueueBytes: factoryInit?.maxQueueBytes ?? Number.POSITIVE_INFINITY
      };

      this.url = init.url;
      this.#maxQueueBytes = init.maxQueueBytes ?? Number.POSITIVE_INFINITY;
      // kick off upgrade (no await in constructor)
      void this.#connect(init);
    }

    // Hybrid readyState:
    // - Before we attach to raw: CONNECTING (override)
    // - After close() but before 'close' event: CLOSING (override)
    // - Otherwise: proxy raw.readyState if available
    get readyState(): number {
      if (this.#stateOverride != null) return this.#stateOverride;
      const rs = (this.#ws as any)?.readyState;
      return typeof rs === "number" ? rs : WebSocketShim.CONNECTING;
    }

    // Approximate number of bytes queued while CONNECTING
    get bufferedAmount(): number {
      return this.#queuedBytes;
    }

    // Public API ---------------------------------------------------------------

    send(data: WSData) {
      const state = this.readyState;
      if (state === WebSocketShim.OPEN) {
        this.#ws!.send(data as any);
        return;
      }
      if (state === WebSocketShim.CLOSING || state === WebSocketShim.CLOSED) {
        throw new Error("WebSocketShim: cannot send() after close() has begun");
      }
      // CONNECTING: enqueue with size accounting
      const size = byteLength(data);
      if (this.#queuedBytes + size > this.#maxQueueBytes) {
        throw new Error("WebSocketShim: CONNECTING queue exceeded maxQueueBytes");
      }
      this.#queue.push(data);
      this.#queuedBytes += size;
    }

    close(code = 1000, reason = "Normal Closure") {
      // If never attached (still CONNECTING and handshake not yet produced a socket),
      // synthesize a clean close immediately.
      if (!this.#ws) {
        this.#stateOverride = WebSocketShim.CLOSED;
        this.#queue.length = 0;
        this.#queuedBytes = 0;
        const ev = new CloseEvent("close", { code, reason, wasClean: true });
        this.dispatchEvent(ev);
        // Don't call this.onclose manually - dispatchEvent handles it
        return;
      }

      const state = this.readyState;
      if (state === WebSocketShim.CLOSING || state === WebSocketShim.CLOSED) return;

      // Surface CLOSING immediately; raw often jumps fast to CLOSED.
      this.#stateOverride = WebSocketShim.CLOSING;
      // Drop anything queued — we won't send after close().
      this.#queue.length = 0;
      this.#queuedBytes = 0;

      // Call close on the raw WebSocket but DON'T fire close event here
      // The close event will be fired by the raw WebSocket's close event handler
      // when the server responds with its Close frame (proper WebSocket protocol)
      try { this.#ws.close(code, reason); } catch {/* ignore */}
      // When the real 'close' arrives, listeners clear the override.
    }

    // Internals ---------------------------------------------------------------

    async #connect(init: InternalInit) {
      try {
        const headers = new Headers(init.headers);
        headers.set("Upgrade", "websocket");

        if (init.protocols) {
          const list = Array.isArray(init.protocols) ? init.protocols : [init.protocols];
          headers.set("Sec-WebSocket-Protocol", list.join(", "));
        }

        // Convert WebSocket URL to HTTP URL for fetch routing
        const httpUrl = init.url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

        const req = new Request(httpUrl, { method: "GET", headers });
        const resp = await fetchFn(req);
        console.log('%o', resp);

        const ws = (resp as any).webSocket as WebSocket | undefined;
        if (!ws) {
          throw new Error(`WebSocket upgrade not accepted (status ${resp.status})`);
        }

        ws.accept(); // take ownership in this worker/test environment

        // Check if we were closed before the connection completed
        if (this.readyState === WebSocketShim.CLOSED) {
          ws.close();
          return;
        }

        this.#ws = ws;

        // From here on, we proxy raw readyState unless temporarily overridden.
        this.#stateOverride = null;

        // Pull protocol if present (CF sometimes exposes it)
        this.protocol = (ws as any).protocol ?? this.protocol;

        // Event forwarding - create new events to avoid re-dispatch issues
        ws.addEventListener("open", (e) => {
          // Ensure we aren't forcing a state; raw now reports OPEN.
          this.#stateOverride = null;
          const newEvent = new Event("open");
          this.dispatchEvent(newEvent);
          // Don't call this.onopen manually - dispatchEvent handles it
          void this.#flushQueue();
        });

        ws.addEventListener("message", (e) => {
          const newEvent = new MessageEvent("message", {
            data: e.data,
            origin: e.origin,
            lastEventId: e.lastEventId,
            source: e.source,
            ports: [...e.ports] // Convert readonly array to mutable
          });
          this.dispatchEvent(newEvent);
          // Don't call this.onmessage manually - dispatchEvent handles it
        });

        ws.addEventListener("error", (e) => {
          // Clear any override; raw may transition to CLOSED next.
          this.#stateOverride = null;
          const newEvent = new ErrorEvent("error", {
            error: (e as any).error,
            message: (e as any).message || "WebSocket error",
            filename: (e as any).filename,
            lineno: (e as any).lineno,
            colno: (e as any).colno
          });
          this.dispatchEvent(newEvent);
          // Don't call this.onerror manually - dispatchEvent handles it
        });

        ws.addEventListener("close", (e: CloseEvent) => {
          // Raw reports CLOSED; clear override and drop any pending bytes.
          this.#stateOverride = null;
          this.#queue.length = 0;
          this.#queuedBytes = 0;
          const newEvent = new CloseEvent("close", {
            code: e.code,
            reason: e.reason,
            wasClean: e.wasClean
          });
          this.dispatchEvent(newEvent);
          // Don't call this.onclose manually - dispatchEvent handles it
        });

        // If the raw is already OPEN (rare), synthesize "open" and flush.
        if ((ws as any).readyState === WebSocketShim.OPEN) {
          const ev = new Event("open");
          this.dispatchEvent(ev);
          // Don't call this.onopen manually - dispatchEvent handles it
          void this.#flushQueue();
        }
      } catch (err) {
        // Connection failed -> error + CLOSED
        const ee = new ErrorEvent("error", { error: err as any, message: (err as any)?.message ?? String(err) });
        this.dispatchEvent(ee);
        // Don't call this.onerror manually - dispatchEvent handles it

        this.#stateOverride = WebSocketShim.CLOSED;
        this.#queue.length = 0;
        this.#queuedBytes = 0;

        const ce = new CloseEvent("close", {
          code: 1011,
          reason: (err as any)?.message || "WebSocket connect failed",
          wasClean: false,
        });
        this.dispatchEvent(ce);
        // Don't call this.onclose manually - dispatchEvent handles it
      }
    }

    async #flushQueue() {
      if (this.#flushing) return;
      this.#flushing = true;
      try {
        while (this.readyState === WebSocketShim.OPEN && this.#queue.length) {
          const msg = this.#queue.shift()!;
          this.#queuedBytes -= byteLength(msg);
          this.#ws!.send(msg as any);
          // Yield to the event loop so large queues don't starve events
          await 0;
        }
      } finally {
        this.#flushing = false;
      }
    }
  }

  return WebSocketShim as any;
}

// Helper: approximate byte length for bufferedAmount accounting
function byteLength(data: WSData): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Blob) return data.size;
  return 0;
}