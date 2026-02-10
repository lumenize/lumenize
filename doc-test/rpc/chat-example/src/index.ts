import { lumenizeRpcDO, sendDownstream } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/routing';
import { DurableObject } from 'cloudflare:workers';

// ========== Type Definitions ==========

interface Message {
  id: number;
  userId: string;
  text: string;
}

interface Participant {
  userId: string;
  permissions: string[];
}

// ========== User Durable Object ==========

class _User extends DurableObject<Env> {
  #env: Env; // Hidden - cannot hop via RPC or access Workers KV
  #tokenExpired: boolean = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#env = env; 
    delete (this as any).env;  // Hide env from external access
    // Security: #env is private, so client can't access env.TOKENS KV
    // or hop to other DOs without going through permission-checked methods
  }

  // User settings (demonstrates Map type support)
  updateSettings(settings: Map<string, any>): void {
    this.ctx.storage.kv.put('userSettings', settings);
  }

  getSettings(): Map<string, any> {
    return this.ctx.storage.kv.get('userSettings') ?? new Map();
  }

  // Room interaction facade (permission-checked)
  async joinRoom(userId: string): Promise<{ messageCount: number; participants: string[] }> {
    // Store userId for later use
    // WebSocket is already tagged with userId (sent as clientId in protocols)
    this.ctx.storage.kv.put('userId', userId);
    return await this.#env.ROOM.getByName('general').addParticipant(userId);
  }

  async postMessage(text: string): Promise<void> {
    this.#checkAuth();

    const userId = this.ctx.storage.kv.get<string>('userId');
    if (!userId) throw new Error('Must join room first');

    const room = this.#env.ROOM.getByName('general');
    const permissions = await room.getUserPermissions(userId);

    if (!permissions.includes('post')) {
      throw new Error('No permission to post');
    }

    await room.postMessage(userId, text);
  }

  async getMessages(fromId?: number): Promise<Message[]> {
    return await this.#env.ROOM.getByName('general').getMessages(fromId);
  }

  // Called by Room DO via Workers RPC to forward downstream to client
  async sendDownstream(payload: any): Promise<void> {
    const userId = this.ctx.storage.kv.get<string>('userId');
    if (!userId) return;
    await sendDownstream(userId, this, payload);
  }

  // Test helper to simulate token expiration
  simulateTokenExpiration(): void {
    this.#tokenExpired = true;
  }

  #checkAuth(): void {
    if (this.#tokenExpired) {
      // Close this user's WebSocket connections with custom code
      const userId = this.ctx.storage.kv.get<string>('userId');
      this.ctx.getWebSockets(userId).forEach((socket) => socket.close(4401, 'Token expired'));
      throw new Error('Token expired');
    }
  }
}

// Wrap with RPC support
export const User = lumenizeRpcDO(_User);

// ========== Room Durable Object ==========

export class Room extends DurableObject<Env> {
  #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); // Call super first
    this.#env = env;
    delete (this as any).env; // Hide env from external access
    // Note: this.ctx is inherited from super and remains accessible
  }

  // Helper to get participants from storage
  #getParticipants(): Map<string, Participant> {
    return this.ctx.storage.kv.get<Map<string, Participant>>('participants') ?? new Map();
  }

  // Helper to save participants to storage
  #saveParticipants(participants: Map<string, Participant>): void {
    this.ctx.storage.kv.put('participants', participants);
  }

  async addParticipant(
    userId: string
  ): Promise<{
    messageCount: number;
    participants: string[];
  }> {
    const participants = this.#getParticipants();

    // Add with default permissions (post allowed, but not for read-only users)
    participants.set(userId, {
      userId,
      permissions: ['post'],
    });

    this.#saveParticipants(participants);

    // Notify all participants (including the new user for multi-tab scenarios)
    await this.#broadcastToAll({
      type: 'user_joined',
      userId,
    });

    const messageCount = this.ctx.storage.kv.get<number>('messageCount') ?? 0;
    return {
      messageCount,
      participants: Array.from(participants.values()).map((p) => p.userId),
    };
  }

  async postMessage(userId: string, text: string): Promise<void> {
    const participants = this.#getParticipants();
    const participant = participants.get(userId);
    if (!participant) throw new Error('User not in room');

    // Get next message ID
    const messageCount = this.ctx.storage.kv.get<number>('messageCount') ?? 0;
    const messageId = messageCount + 1;
    this.ctx.storage.kv.put('messageCount', messageId);

    // Create message
    const message: Message = {
      id: messageId,
      userId,
      text,
    };

    // Store message
    this.ctx.storage.kv.put(`message:${messageId}`, message);

    // Broadcast to all participants
    await this.#broadcastToAll({ type: 'message', message });
  }

  getMessages(fromId?: number): Message[] {
    const messageCount = this.ctx.storage.kv.get<number>('messageCount') ?? 0;
    const messages: Message[] = [];

    const startId = fromId ? fromId + 1 : 1;
    for (let i = startId; i <= messageCount; i++) {
      const message = this.ctx.storage.kv.get<Message>(`message:${i}`);
      if (message) messages.push(message);
    }

    return messages;
  }

  getUserPermissions(userId: string): string[] {
    const participants = this.#getParticipants();
    return participants.get(userId)?.permissions ?? [];
  }

  // Broadcast to all participants via their User DOs
  async #broadcastToAll(payload: any): Promise<void> {
    const participants = this.#getParticipants();
    const userIds = Array.from(participants.keys());
    await Promise.all(
      userIds.map((userId) => this.#env.USER.getByName(userId).sendDownstream(payload))
    );
  }
}

// ========== Worker ==========

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Login endpoint (in Worker, not DO)
    if (url.pathname === '/login') {
      const userId = url.searchParams.get('userId');
      if (!userId) {
        return new Response('userId required', { status: 400 });
      }

      // Generate random authentication token
      const token = crypto.randomUUID();

      // Store token in Workers KV with userId as key
      await env.TOKENS.put(userId, token, {
        expirationTtl: 3600, // 1 hour
      });

      return new Response(JSON.stringify({ token, userId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Route to User DO with authentication
    const response = await routeDORequest(request, env, {
      prefix: '__rpc',
      onBeforeConnect: async (request, { doNamespace, doInstanceNameOrId }) => {
        // Extract userId (clientId) from protocols header
        const protocols = request.headers.get('Sec-WebSocket-Protocol');
        const protocolArray = protocols?.split(',').map((p) => p.trim()) ?? [];
        const clientIdProtocol = protocolArray.find((p) =>
          p.startsWith('lumenize.rpc.clientId.')
        );
        const userId = clientIdProtocol?.substring('lumenize.rpc.clientId.'.length);

        if (!userId) {
          return new Response('Unauthorized - No userId', { status: 401 });
        }

        // Verify that the userId matches the URL's doInstanceNameOrId
        // This ensures the client is connecting to their own DO
        if (userId !== doInstanceNameOrId) {
          return new Response('Unauthorized - User/DO mismatch', { status: 403 });
        }

        // Extract token from additional protocols
        const tokenProtocol = protocolArray.find((p) => p.startsWith('token.'));
        const token = tokenProtocol?.substring('token.'.length);

        if (!token) {
          return new Response('Unauthorized - No token', { status: 401 });
        }

        // Validate token against Workers KV (userId is the key)
        const storedToken = await env.TOKENS.get(userId);
        if (!storedToken || storedToken !== token) {
          return new Response('Unauthorized - Invalid or expired token', { status: 401 });
        }

        return undefined; // Continue with the request
      },
    });

    if (response) return response;

    // Fallback for non-RPC requests
    return new Response('Not Found', { status: 404 });
  },
};

