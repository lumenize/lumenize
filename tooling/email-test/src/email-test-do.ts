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
  /**
   * Value of the `X-Lumenize-Auth-Instance` header (populated by
   * `NebulaEmailSender.magicLinkHeaders`). Used by concurrent test runs to
   * subscribe to only their own scope's emails — see fetch('/ws?instance=...').
   * Empty string if the header was absent.
   */
  instance: string;
}

/** Per-instance email storage. Keyed by attached `instance` string. */
const EMAILS_KEY_PREFIX = 'emails:';
/** Catch-all key used when an email arrives with no instance header. */
const NO_INSTANCE_KEY = `${EMAILS_KEY_PREFIX}<none>`;
/** Header name (lowercased — postal-mime exposes header keys lowercase). */
const INSTANCE_HEADER = 'x-lumenize-auth-instance';

/** Attachment shape persisted across WS hibernation via serializeAttachment. */
interface WsAttachment {
  /** Empty string means "match all" (broadcast subscriber, default). */
  instance: string;
}

export class EmailTestDO extends DurableObject {

  /**
   * Accept a raw email (from the Worker's email() handler), parse it with
   * postal-mime, store in KV (keyed by the `X-Lumenize-Auth-Instance` header
   * if present), and push to matching WebSocket clients.
   */
  async receiveEmail(raw: ArrayBuffer): Promise<StoredEmail> {
    const parsed = await PostalMime.parse(raw);

    const instance =
      parsed.headers.find((h) => h.key === INSTANCE_HEADER)?.value ?? '';

    const stored: StoredEmail = {
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      html: parsed.html,
      text: parsed.text,
      messageId: parsed.messageId,
      date: parsed.date,
      receivedAt: new Date().toISOString(),
      instance,
    };

    // Append to per-instance KV bucket. Keeps concurrent test runs from
    // overwriting each other's stored emails.
    const key = this.#emailsKeyFor(instance);
    const emails = this.ctx.storage.kv.get<StoredEmail[]>(key) ?? [];
    emails.push(stored);
    this.ctx.storage.kv.put(key, emails);

    // Push to matching WebSocket subscribers: a subscriber's attached
    // `instance` must match the email's `instance` exactly, OR be empty
    // (empty-string attachment = broadcast — subscribe to everything).
    const message = JSON.stringify(stored);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = (ws.deserializeAttachment() ?? { instance: '' }) as WsAttachment;
      if (attachment.instance === '' || attachment.instance === instance) {
        ws.send(message);
      }
    }

    return stored;
  }

  /**
   * Return stored emails. With `instance` set, only emails whose
   * `X-Lumenize-Auth-Instance` header matched; otherwise everything.
   */
  getEmails(instance?: string): StoredEmail[] {
    if (instance !== undefined) {
      return this.ctx.storage.kv.get<StoredEmail[]>(this.#emailsKeyFor(instance)) ?? [];
    }
    const out: StoredEmail[] = [];
    for (const [, value] of this.ctx.storage.kv.list<StoredEmail[]>({ prefix: EMAILS_KEY_PREFIX })) {
      out.push(...value);
    }
    return out;
  }

  /**
   * Clear stored emails. With `instance` set, clears only that bucket;
   * otherwise wipes everything (current default — preserves existing
   * single-tenant callers).
   */
  clearEmails(instance?: string): void {
    if (instance !== undefined) {
      this.ctx.storage.kv.delete(this.#emailsKeyFor(instance));
      return;
    }
    for (const [key] of this.ctx.storage.kv.list<StoredEmail[]>({ prefix: EMAILS_KEY_PREFIX })) {
      this.ctx.storage.kv.delete(key);
    }
  }

  #emailsKeyFor(instance: string): string {
    return instance === '' ? NO_INSTANCE_KEY : `${EMAILS_KEY_PREFIX}${instance}`;
  }

  // --- Hibernation WebSocket API ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const instance = url.searchParams.get('instance') ?? '';

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // Persist instance filter across hibernation. Empty string = broadcast
      // (legacy callers that don't pass ?instance= subscribe to everything).
      const attachment: WsAttachment = { instance };
      server.serializeAttachment(attachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/emails') {
      // ?instance= filters; absent → everything across all buckets
      const filter = url.searchParams.has('instance') ? instance : undefined;
      return Response.json(this.getEmails(filter));
    }

    if (url.pathname === '/clear' && request.method === 'POST') {
      const filter = url.searchParams.has('instance') ? instance : undefined;
      this.clearEmails(filter);
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
