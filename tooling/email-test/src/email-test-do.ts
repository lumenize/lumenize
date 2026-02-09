import { DurableObject } from 'cloudflare:workers';
import PostalMime from 'postal-mime';
import type { Email } from 'postal-mime';

export interface StoredEmail {
  from: Email['from'];
  to: Email['to'];
  subject: Email['subject'];
  html: Email['html'];
  text: Email['text'];
  messageId: Email['messageId'];
  date: Email['date'];
  receivedAt: string;
}

const EMAILS_KEY = 'emails';

export class EmailTestDO extends DurableObject {

  /**
   * Accept a raw email (from the Worker's email() handler), parse it with
   * postal-mime, store in KV, and push to all connected WebSocket clients.
   */
  async receiveEmail(raw: ArrayBuffer): Promise<StoredEmail> {
    const parsed = await PostalMime.parse(raw);

    const stored: StoredEmail = {
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      html: parsed.html,
      text: parsed.text,
      messageId: parsed.messageId,
      date: parsed.date,
      receivedAt: new Date().toISOString(),
    };

    // Append to KV array
    const emails = this.ctx.storage.kv.get<StoredEmail[]>(EMAILS_KEY) ?? [];
    emails.push(stored);
    this.ctx.storage.kv.put(EMAILS_KEY, emails);

    // Push to all connected WebSocket clients
    const message = JSON.stringify(stored);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(message);
    }

    return stored;
  }

  /** Return all stored emails (for debugging/verification). */
  getEmails(): StoredEmail[] {
    return this.ctx.storage.kv.get<StoredEmail[]>(EMAILS_KEY) ?? [];
  }

  /** Clear all stored emails. */
  clearEmails(): void {
    this.ctx.storage.kv.delete(EMAILS_KEY);
  }

  // --- Hibernation WebSocket API ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/emails') {
      return Response.json(this.getEmails());
    }

    if (url.pathname === '/clear' && request.method === 'POST') {
      this.clearEmails();
      return new Response('cleared', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Test clients don't send meaningful messages; echo back for diagnostics
    ws.send(typeof message === 'string' ? message : 'binary');
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Code 1005 means "no status code was present" — not a valid close code to send back.
    // Use 1000 (normal closure) as the fallback.
    ws.close(code === 1005 ? 1000 : code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('EmailTestDO WebSocket error:', error);
  }
}
