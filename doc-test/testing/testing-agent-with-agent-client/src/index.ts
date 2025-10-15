import { Agent, routeAgentRequest, Connection, ConnectionContext, WSMessage } from "agents";

// Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle login endpoint
    if (url.pathname === '/login') {
      const password = url.searchParams.get('password');
      if (!password) {
        return new Response('Password required', { status: 400 });
      }

      // Confirm password - not shown
      
      // Generate session ID and token
      const sessionId = crypto.randomUUID();
      const token = crypto.randomUUID();
      
      // Store session -> token mapping in KV
      await env.SESSION_STORE.put(sessionId, token);
      
      // Set cookie and return token in body
      return new Response(JSON.stringify({ token }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `sessionId=${sessionId}; Path=/; HttpOnly; SameSite=Strict`
        }
      });
    }
    
    return (
      await routeAgentRequest(request, env) ||
      new Response("Not Found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

interface ChatState {
  messages: Array<{ sender: string; text: string; }>;
  participants: string[];
}

// Agent
export class ChatAgent extends Agent<Env, ChatState>{
  initialState = {
    messages: [],
    participants: [],
  };

  lastMessage: Date | null = null;

  onMessage(connection: Connection, message: WSMessage) {
    const msg = JSON.parse(message as string);

    this.lastMessage = new Date();

    if (msg.type === 'join') {
      // Add participant to state
      this.setState({
        ...this.state,
        participants: [...this.state.participants, msg.username],
      });
    } else if (msg.type === 'chat') {
      // Increment total message count in storage
      const count = this.ctx.storage.kv.get<number>('totalMessageCount') ?? 0;
      this.ctx.storage.kv.put('totalMessageCount', count + 1);
      
      // Add chat message to state
      this.setState({
        ...this.state,
        messages: [...this.state.messages, { 
          sender: msg.username, 
          text: msg.text,
        }],
      });
    }
  }
};

// AuthAgent - demonstrates authentication with token validation
export class AuthAgent extends Agent<Env, {}> {
  async onConnect(connection: Connection, ctx: ConnectionContext) {
    // Extract token from WebSocket protocol (second protocol in the array)
    const protocols = ctx.request.headers.get('Sec-WebSocket-Protocol');
    const token = protocols?.split(',')
      .map(p => p.trim()).find(p => p.startsWith('auth.'))?.slice(5);
    
    // Extract sessionId from cookie
    const cookieHeader = ctx.request.headers.get('Cookie');
    const sessionId = cookieHeader?.split(';')
      .map(c => c.trim()).find(c => c.startsWith('sessionId='))?.slice(10);
    
    if (!token || !sessionId) {
      return connection.close(1008, 'Missing authentication credentials');
    }
    
    // Validate token matches sessionId in KV
    const storedToken = await this.env.SESSION_STORE.get(sessionId);
    if (storedToken !== token) {
      return connection.close(1008, 'Invalid authentication token');
    }
    
    // Authentication successful - echo back the sessionId
    // In a real app, you might store session info in the DO or do other setup
    connection.send(JSON.stringify({ 
      type: 'auth_success', 
      sessionId,
      message: 'Authentication successful'
    }));
  }
}
