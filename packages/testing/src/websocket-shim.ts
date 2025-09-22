// Cloudflare (cloudflare:test) WebSocket shim with CONNECTING queue
// and hybrid readyState that mostly proxies the raw socket.
//
// Usage:
//   // Basic usage (browser-compatible):
//   const WebSocketShimClass = getWebSocketShim(SELF);
//   const ws1 = new WebSocketShimClass("wss://example.test/room/42");
//   const ws2 = new WebSocketShimClass("wss://example.test/room/42", ["chat.v2", "chat.v1"]);
//   
//   // With testing-specific options (headers, queue limits):
//   const WebSocketShimClass = getWebSocketShim(SELF, { 
//     headers: { "Authorization": "Bearer token" },
//     maxQueueBytes: 1024 
//   });
//   const ws3 = new WebSocketShimClass("wss://example.test/room/42");
//   
//   ws.send("hello while connecting is OK"); // queued
//   ws.onopen = () => ws.send("hi after open");
//   ws.onmessage = (e) => console.log("msg:", e.data);
//   ws.onclose = (e) => console.log("closed:", e.code, e.reason);

type WSData = string | ArrayBuffer | Blob | Uint8Array;

interface FactoryInit {
  headers?: Record<string, string>;
  maxQueueBytes?: number; // optional cap for queued bytes during CONNECTING
}

interface InternalInit {
  url: string;
  protocols?: string | string[];
  headers?: Record<string, string>;
  maxQueueBytes?: number;
}

export function getWebSocketShim(SELF: any, factoryInit?: FactoryInit) {
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
        this.onclose?.(ev);
        return;
      }

      const state = this.readyState;
      if (state === WebSocketShim.CLOSING || state === WebSocketShim.CLOSED) return;

      // Surface CLOSING immediately; raw often jumps fast to CLOSED.
      this.#stateOverride = WebSocketShim.CLOSING;
      // Drop anything queued — we won't send after close().
      this.#queue.length = 0;
      this.#queuedBytes = 0;
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

        const req = new Request(init.url, { method: "GET", headers });
        const resp = await SELF.fetch(req);

        const ws = (resp as any).webSocket as WebSocket | undefined;
        if (!ws) {
          throw new Error(`WebSocket upgrade not accepted (status ${resp.status})`);
        }

        ws.accept(); // take ownership in this worker/test environment
        this.#ws = ws;

        // From here on, we proxy raw readyState unless temporarily overridden.
        this.#stateOverride = null;

        // Pull protocol if present (CF sometimes exposes it)
        this.protocol = (ws as any).protocol ?? this.protocol;

        // Event forwarding
        ws.addEventListener("open", (e) => {
          // Ensure we aren't forcing a state; raw now reports OPEN.
          this.#stateOverride = null;
          this.dispatchEvent(e);
          this.onopen?.(e);
          void this.#flushQueue();
        });

        ws.addEventListener("message", (e) => {
          this.dispatchEvent(e);
          this.onmessage?.(e);
        });

        ws.addEventListener("error", (e) => {
          // Clear any override; raw may transition to CLOSED next.
          this.#stateOverride = null;
          this.dispatchEvent(e);
          this.onerror?.(e);
        });

        ws.addEventListener("close", (e: CloseEvent) => {
          // Raw reports CLOSED; clear override and drop any pending bytes.
          this.#stateOverride = null;
          this.#queue.length = 0;
          this.#queuedBytes = 0;
          this.dispatchEvent(e);
          this.onclose?.(e);
        });

        // If the raw is already OPEN (rare), synthesize "open" and flush.
        if ((ws as any).readyState === WebSocketShim.OPEN) {
          const ev = new Event("open");
          this.dispatchEvent(ev);
          this.onopen?.(ev);
          void this.#flushQueue();
        }
      } catch (err) {
        // Connection failed -> error + CLOSED
        const ee = new ErrorEvent("error", { error: err as any, message: (err as any)?.message ?? String(err) });
        this.dispatchEvent(ee);
        this.onerror?.(ee);

        this.#stateOverride = WebSocketShim.CLOSED;
        this.#queue.length = 0;
        this.#queuedBytes = 0;

        const ce = new CloseEvent("close", {
          code: 1011,
          reason: (err as any)?.message || "WebSocket connect failed",
          wasClean: false,
        });
        this.dispatchEvent(ce);
        this.onclose?.(ce);
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
  
  return WebSocketShim;
}

// Helper: approximate byte length for bufferedAmount accounting
function byteLength(data: WSData): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Blob) return data.size;
  return 0;
}
