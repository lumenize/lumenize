import { lumenizeRpcDO, sendDownstream } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { DurableObject } from 'cloudflare:workers';

// ========== Type Definitions ==========

interface Message {
  id: number;
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
}

interface Participant {
  userId: string;
  username: string;
  permissions: string[];
}

// ========== User Durable Object ==========

class _User extends DurableObject<Env> {
  #clientId: string | null = null;
  #env: Env; // Hidden - cannot hop via RPC or access Workers KV
  #tokenExpired: boolean = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#env = env; // Hide env from external access
    // Security: #env is private, so client can't access env.TOKENS KV
    // or hop to other DOs without going through permission-checked methods
  }

  // Called internally by lumenizeRpcDO when WebSocket connects
  __setClientId(clientId: string): void {
    this.#clientId = clientId;
  }

  // User settings (demonstrates Map type support)
  async updateSettings(settings: Map<string, any>): Promise<void> {
    this.ctx.storage.kv.put('userSettings', settings);
  }

  async getSettings(): Promise<Map<string, any>> {
    return this.ctx.storage.kv.get('userSettings') ?? new Map();
  }

  // Room interaction facade (permission-checked)
  async joinRoom(): Promise<{ messageCount: number; participants: string[] }> {
    const settings = await this.getSettings();
    const username = settings.get('name') ?? 'Anonymous';

    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    return await room.addParticipant(this.#clientId!, username);
  }

  async postMessage(text: string): Promise<void> {
    this.#checkAuth();

    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    const permissions = await room.getUserPermissions(this.#clientId!);

    if (!permissions.includes('post')) {
      throw new Error('No permission to post');
    }

    await room.postMessage(this.#clientId!, text);
  }

  async updateMessage(messageId: number, newText: string): Promise<void> {
    this.#checkAuth();

    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    await room.updateMessage(this.#clientId!, messageId, newText);
  }

  async getMessages(fromId?: number): Promise<Message[]> {
    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    return await room.getMessages(fromId);
  }

  async leaveRoom(): Promise<void> {
    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    await room.removeParticipant(this.#clientId!);
  }

  // Called by Room DO via Workers RPC to forward downstream
  async receiveDownstream(payload: any): Promise<void> {
    if (!this.#clientId) return;
    await sendDownstream(this.#clientId, this, payload);
  }

  // Test helper to simulate token expiration
  async simulateTokenExpiration(): Promise<void> {
    this.#tokenExpired = true;
  }

  #checkAuth(): void {
    if (this.#tokenExpired) {
      // Close WebSocket with custom code
      const sockets = this.ctx.getWebSockets();
      for (const socket of sockets) {
        socket.close(4401, 'Token expired');
      }
      throw new Error('Token expired');
    }
  }
}

// Wrap with RPC support
export const User = lumenizeRpcDO(_User);

// ========== Room Durable Object ==========

class _Room extends DurableObject<Env> {
  #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); // Call super first
    this.#env = env;
    // Note: this.ctx is inherited from super and remains accessible
    // We only hide #env to prevent external DO hopping
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
    userId: string,
    username: string
  ): Promise<{
    messageCount: number;
    participants: string[];
  }> {
    const participants = this.#getParticipants();

    // Add with default permissions
    participants.set(userId, {
      userId,
      username,
      permissions: ['post', 'update'], // Not 'moderate'
    });

    this.#saveParticipants(participants);

    // Notify all other participants
    await this.#broadcastToOthers(userId, {
      type: 'user_joined',
      userId,
      username,
    });

    const messageCount = this.ctx.storage.kv.get<number>('messageCount') ?? 0;
    return {
      messageCount,
      participants: Array.from(participants.values()).map((p) => p.username),
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

    // Create message (demonstrates Date type support)
    const message: Message = {
      id: messageId,
      userId,
      username: participant.username,
      text,
      timestamp: new Date(),
    };

    // Store message
    this.ctx.storage.kv.put(`message:${messageId}`, message);

    // Broadcast to all participants
    await this.#broadcastToAll({ type: 'message', message });
  }

  async updateMessage(userId: string, messageId: number, newText: string): Promise<void> {
    const participants = this.#getParticipants();
    const participant = participants.get(userId);
    if (!participant) throw new Error('User not in room');

    // Get existing message
    const message = this.ctx.storage.kv.get<Message>(`message:${messageId}`);
    if (!message) throw new Error('Message not found');

    // Check if user owns the message (permission check)
    if (message.userId !== userId && !participant.permissions.includes('moderate')) {
      throw new Error('No permission to update this message');
    }

    // Update message
    message.text = newText;
    this.ctx.storage.kv.put(`message:${messageId}`, message);

    // Broadcast update
    await this.#broadcastToAll({ type: 'message_updated', messageId, newText });
  }

  async getMessages(fromId?: number): Promise<Message[]> {
    const messageCount = this.ctx.storage.kv.get<number>('messageCount') ?? 0;
    const messages: Message[] = [];

    const startId = fromId ? fromId + 1 : 1;
    for (let i = startId; i <= messageCount; i++) {
      const message = this.ctx.storage.kv.get<Message>(`message:${i}`);
      if (message) messages.push(message);
    }

    return messages;
  }

  async removeParticipant(userId: string): Promise<void> {
    const participants = this.#getParticipants();
    const participant = participants.get(userId);
    if (!participant) return;

    participants.delete(userId);
    this.#saveParticipants(participants);

    await this.#broadcastToOthers(userId, {
      type: 'user_left',
      userId,
      username: participant.username,
    });
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    const participants = this.#getParticipants();
    return participants.get(userId)?.permissions ?? [];
  }

  // Broadcast to all participants via their User DOs
  async #broadcastToAll(payload: any): Promise<void> {
    const participants = this.#getParticipants();
    const userIds = Array.from(participants.keys());
    await Promise.all(
      userIds.map(async (userId) => {
        const userStub = this.#env.USER.get(this.#env.USER.idFromName(userId));
        await userStub.receiveDownstream(payload);
      })
    );
  }

  // Broadcast to all except one user
  async #broadcastToOthers(excludeUserId: string, payload: any): Promise<void> {
    const participants = this.#getParticipants();
    const userIds = Array.from(participants.keys()).filter((id) => id !== excludeUserId);
    await Promise.all(
      userIds.map(async (userId) => {
        const userStub = this.#env.USER.get(this.#env.USER.idFromName(userId));
        await userStub.receiveDownstream(payload);
      })
    );
  }
}

// Wrap with RPC support
export const Room = lumenizeRpcDO(_Room);

// ========== Worker ==========

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Login endpoint (in Worker, not DO)
    if (url.pathname === '/login') {
      const username = url.searchParams.get('username');
      if (!username) {
        return new Response('Username required', { status: 400 });
      }

      // Generate token (simplified: token = userId)
      const token = `user-${username.toLowerCase()}`;

      // Store token in Workers KV with expiration
      await env.TOKENS.put(token, JSON.stringify({ username }), {
        expirationTtl: 3600, // 1 hour
      });

      return new Response(JSON.stringify({ token }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Route to User DO with authentication
    const response = await routeDORequest(request, env, {
      prefix: '__rpc',
      doNamespace: env.USER, // Route to User DO
      doInstanceNameOrId: 'from-token', // Extract from token below
      onBeforeConnect: async (request, { doNamespace, doInstanceNameOrId }) => {
        // Extract token/clientId from protocols
        const protocols = request.headers.get('Sec-WebSocket-Protocol');
        const protocolArray = protocols?.split(',').map((p) => p.trim()) ?? [];
        const clientIdProtocol = protocolArray.find((p) =>
          p.startsWith('lumenize.rpc.clientId.')
        );
        const token = clientIdProtocol?.substring('lumenize.rpc.clientId.'.length);

        if (!token) {
          return new Response('Unauthorized', { status: 401 });
        }

        // Validate token against Workers KV
        const tokenData = await env.TOKENS.get(token);
        if (!tokenData) {
          return new Response('Unauthorized - Invalid token', { status: 401 });
        }

        // Token IS the userId for simplicity (e.g., 'user-alice')
        // KV expiration handles token expiration automatically
        // Update the DO instance name to use the token as userId
        return {
          doInstanceNameOrId: token, // e.g., 'user-alice'
          request: request,
        };
      },
    });

    if (response) return response;

    // Fallback for non-RPC requests
    return new Response('Not Found', { status: 404 });
  },
};

