import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { newWorkersRpcResponse, RpcStub } from 'capnweb';

// =======================================================================
// Lumenize RPC - User and Room services
// =======================================================================

// Room stores messages using Map<number, string>
// - a StructuredClone type
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
  room(
    roomName: string,
    method: string,
    ...params: any[]
  ): Promise<any> {
    return (this.env.ROOM.getByName(roomName) as any)[method](
      ...params
    );
  }
}

export const User = lumenizeRpcDO(_User);

// =======================================================================
// Cap'n Web - More boilerplate and limitations
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
  addMessage(text: string): number {
    const messages =
      this.ctx.storage.kv.get<Record<number, string>>('messages') ??
      {};
    const id = Object.keys(messages).length + 1;
    messages[id] = text;
    this.ctx.storage.kv.put('messages', messages);
    return id;
  }

  getMessages(): Record<number, string> {
    return (
      this.ctx.storage.kv.get<Record<number, string>>('messages') ??
      {}
    );
  }
}

// Cap'n Web API - RpcTarget instantiated directly in worker
// (no DO needed for API layer)
// Per Cap'n Web docs pattern: worker creates `new MyApiServer()`
// in fetch handler
export class CapnWebApi extends RpcTarget {
  constructor(private env: Env) {
    super();
  }

  // Return Workers RPC stub to Room
  // (uses Map - will fail on getMessages())
  getRoom(roomName: string) {
    const roomId = this.env.CAPNWEB_ROOM.idFromName(roomName);
    return this.env.CAPNWEB_ROOM.get(roomId);
  }

  // Return Workers RPC stub to PlainRoom
  // (uses plain object - will work)
  getPlainRoom(roomName: string) {
    const roomId = this.env.CAPNWEB_PLAIN_ROOM.idFromName(roomName);
    return this.env.CAPNWEB_PLAIN_ROOM.get(roomId);
  }
}

// =======================================================================
// Worker - Route requests to appropriate service
// =======================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Route Lumenize RPC requests (both User and Room)
    const lumenizeResponse = await routeDORequest(
      request,
      env,
      { prefix: '__rpc' }
    );
    if (lumenizeResponse) return lumenizeResponse;
    
    // Route Cap'n Web RPC requests
    // - instantiate RpcTarget directly per Cap'n Web pattern
    if (url.pathname === '/capnweb/api') {
      return newWorkersRpcResponse(request, new CapnWebApi(env));
    }

    // Fallback for non-RPC requests
    return new Response('Not found', { status: 404 });
  },
};
