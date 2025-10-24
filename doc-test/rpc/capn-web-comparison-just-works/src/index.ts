import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { newWorkersRpcResponse, RpcStub } from 'capnweb';

// =======================================================================
// Lumenize RPC - User and Room services
// =======================================================================

// Room stores messages using Map<number, string>
export class Room extends DurableObject {
  addMessage(text: string): number {
    const messages =
      this.ctx.storage.kv.get<Map<number, string>>('messages') ??
      new Map();
    const id = messages.size + 1;
    messages.set(id, text);
    this.ctx.storage.kv.put('messages', messages);
    return id;
  }

  getMessages(): Map<number, string> {
    return (
      this.ctx.storage.kv.get<Map<number, string>>('messages') ??
      new Map()
    );
  }
}

// User acts as a gateway, hopping to Room via env
class _User extends DurableObject<Env> {
  // Generic method forwarder - calls any Room method by name
  room(roomName: string, method: string, ...params: any[]): Promise<any> {
    return (this.env.ROOM.getByName(roomName) as any)[method](...params);
  }
}

export const User = lumenizeRpcDO(_User);

// =======================================================================
// Cap'n Web - Clean and elegant
// =======================================================================

// Cap'n Web Room - Uses Map (will fail on getMessages())
export class CapnWebRoom extends DurableObject<Env> {
  addMessage(text: string): number {
    const messages =
      this.ctx.storage.kv.get<Map<number, string>>('messages') ??
      new Map();
    const id = messages.size + 1;
    messages.set(id, text);
    this.ctx.storage.kv.put('messages', messages);
    return id;
  }

  getMessages(): Map<number, string> {
    return (
      this.ctx.storage.kv.get<Map<number, string>>('messages') ??
      new Map()
    );
  }
}

// Cap'n Web PlainRoom - Uses plain object (will work)
export class CapnWebPlainRoom extends DurableObject<Env> {
  // Store callbacks to test multi-hop scenario
  #callbacks = new Map<string, (message: string) => void>();
  #joinPromises = new Map<string, {resolve: () => void, reject: (err: any) => void}>();

  async joinAndListen(userName: string, onMessage: (message: string) => void): Promise<void> {
    console.log('CapnWebPlainRoom.joinAndListen called for user:', userName);
    this.#callbacks.set(userName, onMessage);
    console.log('Callback stored, total callbacks:', this.#callbacks.size);
    
    // Don't return - keep the RPC connection alive
    // Create a promise that we'll resolve when the user leaves
    return new Promise((resolve, reject) => {
      this.#joinPromises.set(userName, { resolve, reject });
      // For testing, auto-resolve after 5 seconds
      setTimeout(() => {
        console.log('Auto-resolving join for user:', userName);
        resolve();
      }, 5000);
    });
  }

  join(userName: string, onMessage: (message: string) => void): void {
    console.log('CapnWebPlainRoom.join called for user:', userName);
    this.#callbacks.set(userName, onMessage);
    console.log('Callback stored, total callbacks:', this.#callbacks.size);
  }

  async addMessage(text: string): Promise<number> {
    console.log('CapnWebPlainRoom.addMessage called with:', text);
    console.log('Total callbacks registered:', this.#callbacks.size);
    const messages =
      this.ctx.storage.kv.get<Record<number, string>>('messages') ??
      {};
    const id = Object.keys(messages).length + 1;
    messages[id] = text;
    this.ctx.storage.kv.put('messages', messages);
    
    // Try invoking callbacks
    for (const [userName, callback] of this.#callbacks.entries()) {
      console.log('Attempting to invoke callback for user:', userName);
      try {
        await (callback as any)(text);
        console.log('Callback invoked successfully for user:', userName);
      } catch (error) {
        console.error('Error invoking callback for user:', userName, error);
      }
    }
    
    return id;
  }

  getMessages(): Record<number, string> {
    return (
      this.ctx.storage.kv.get<Record<number, string>>('messages') ??
      {}
    );
  }
}

// Cap'n Web User - RpcTarget instantiated directly in worker
export class CapnWebUser extends RpcTarget {
  constructor(private env: Env) {
    super();
  }

  // Return Workers RPC stub to Room
  // (uses Map - will fail on getMessages())
  getRoom(roomName: string) {
    return this.env.CAPNWEB_ROOM.getByName(roomName);
  }

  // Return Workers RPC stub to PlainRoom
  // (uses plain object - will work)
  getPlainRoom(roomName: string) {
    return this.env.CAPNWEB_PLAIN_ROOM.getByName(roomName);
  }

  // Test callback directly on User (no Room hop)
  async testCallback(callback: (msg: string) => void): Promise<string> {
    await callback('Hello from CapnWebUser!');
    return 'callback invoked';
  }
}

// =======================================================================
// Worker - Route requests to appropriate service
// =======================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Route Lumenize RPC requests (both User and Room)
    const lumenizeResponse = await routeDORequest( request, env, 
      { prefix: '__rpc' });
    if (lumenizeResponse) return lumenizeResponse;
    
    // Route Cap'n Web RPC requests
    // - instantiate RpcTarget directly per Cap'n Web pattern
    if (url.pathname === '/capnweb') {
      return newWorkersRpcResponse(request, new CapnWebUser(env));
    }

    // Fallback for non-RPC requests
    return new Response('Not found', { status: 404 });
  },
};
