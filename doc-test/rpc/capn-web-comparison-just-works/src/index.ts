import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { newWorkersRpcResponse } from 'capnweb';

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

// Cap'n Web PlainRoom - Uses plain object instead of Map
export class CapnWebPlainRoom extends DurableObject<Env> {
  #callbacks = new Map<string, (msg: string) => void>();

  join(userName: string, onMsg: (msg: string) => void): Promise<void> {
    this.#callbacks.set(userName, onMsg);
    
    // This hack keeps the RPC connection alive so callback stub remains valid
    // I suspect there is a way to get rid of this, but if we can't this is
    // doesn't align with "It just works"
    return new Promise((resolve) => {
      setTimeout(() => { resolve(); }, 5000);
    });
  }

  addMessage(text: string): number {
    const messages =
      this.ctx.storage.kv.get<Record<number, string>>('messages') ??
      {};
    const id = Object.keys(messages).length + 1;
    messages[id] = text;
    this.ctx.storage.kv.put('messages', messages);
    
    // Invoke callbacks
    for (const [userName, callback] of this.#callbacks.entries()) {
      callback(text);
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
