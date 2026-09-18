/**
 * Simple test Durable Object for validating createTestingClient
 */
import { DurableObject } from 'cloudflare:workers';
import { routeDORequest } from '@lumenize/routing';

export class TestDO extends DurableObject {
  alarmFiredCount: number = 0;
  lastAlarmPayload: any = null;

  /**
   * Increment a counter in storage
   */
  async increment(): Promise<number> {
    const count = (await this.ctx.storage.get<number>('count')) ?? 0;
    const newCount = count + 1;
    await this.ctx.storage.put('count', newCount);
    return newCount;
  }

  /**
   * Get current count
   */
  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>('count')) ?? 0;
  }

  /**
   * Reset count to zero
   */
  async reset(): Promise<void> {
    await this.ctx.storage.put('count', 0);
  }

  /**
   * Echo back the input
   */
  echo(input: string): string {
    return `Echo: ${input}`;
  }

  /**
   * Return a complex object
   */
  getComplexObject() {
    return {
      nested: {
        value: 42,
        array: [1, 2, 3]
      },
      timestamp: Date.now()
    };
  }

  /**
   * Test accessing ctx.id
   */
  getId(): string {
    return this.ctx.id.toString();
  }

  /**
   * Test accessing ctx.storage
   */
  async setCustomKey(key: string, value: any): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  /**
   * Test accessing ctx.storage
   */
  async getCustomKey(key: string): Promise<any> {
    return await this.ctx.storage.get(key);
  }

  /**
   * Required alarm handler
   */
  async alarm(): Promise<void> {
    this.alarmFiredCount++;
    this.lastAlarmPayload = { fired: true, count: this.alarmFiredCount };
  }

  /**
   * Get alarm fire count
   */
  getAlarmFiredCount(): number {
    return this.alarmFiredCount;
  }

  /**
   * Get last alarm payload
   */
  getLastAlarmPayload(): any {
    return this.lastAlarmPayload;
  }

  /**
   * Schedule an alarm
   */
  scheduleAlarm(delayMs: number): void {
    this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * Basic fetch handler (for non-RPC requests)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/test') {
      return new Response('Test endpoint');
    }

    return new Response('Not found', { status: 404 });
  }
}

/**
 * Installs its WebSocket handlers per instance in the constructor, as the Cloudflare Agents SDK
 * does, and like that SDK skips any handler name the object already has. So a wrapper that defines
 * the same names on its prototype hides these handlers — what browser-websocket.test.ts guards.
 */
export class InstanceHandlerDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const handlers = {
      webSocketMessage: (_ws: WebSocket, message: string | ArrayBuffer) => {
        const seen = this.ctx.storage.kv.get<string[]>('messages') ?? [];
        this.ctx.storage.kv.put('messages', [...seen, String(message)]);
      },
      webSocketClose: (_ws: WebSocket, code: number) => {
        this.ctx.storage.kv.put('closeCode', code);
      },
    };
    for (const [name, handler] of Object.entries(handlers)) {
      if (name in this) continue;
      Object.defineProperty(this, name, { value: handler, configurable: true });
    }
  }

  /**
   * Accepts a WebSocket. `?close=<code>` has the server send one frame and then close, the way an
   * Agent sends its identity frame before a user's `onConnect` can refuse the connection — the
   * frame is what makes the runtime fire a trailing `error` on the client after the `close`.
   */
  fetch(request: Request): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const close = new URL(request.url).searchParams.get('close');
    if (close) {
      pair[1].send('hello from the server');
      pair[1].close(Number(close), 'closed by server');
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  messages(): string[] {
    return this.ctx.storage.kv.get<string[]>('messages') ?? [];
  }

  closeCode(): number | undefined {
    return this.ctx.storage.kv.get<number>('closeCode');
  }
}

/** Routes `/{binding}/{instance}/…` to a DO's own `fetch`, for tests that open a plain WebSocket. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeDORequest(request, env)) ?? new Response('Not found', { status: 404 });
  },
};

