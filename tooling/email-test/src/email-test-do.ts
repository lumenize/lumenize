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
   * `AuthEmailSender.headers`). Used by concurrent test runs to
   * subscribe to only their own scope's emails — see fetch('/ws?instance=...').
   * Empty string if the header was absent.
   */
  instance: string;
}

/**
 * What Resend reported about one send to one recipient, from its webhook. `type` is Resend's event
 * name (`email.delivered`, `email.bounced`, …); `reason` is the bounce's or the failure's own words.
 */
export interface DeliveryEvent {
  type: string;
  recipient: string;
  /** Resend's id for the send. */
  emailId: string;
  subject?: string;
  /** When Resend says the event happened. */
  occurredAt: string;
  /** When this Worker heard of it. */
  receivedAt: string;
  reason?: string;
}

/** What a socket subscribed with `?events=1` receives for a delivery event; mail arrives as a bare `StoredEmail`. */
export interface DeliveryEventMessage {
  kind: 'delivery-event';
  event: DeliveryEvent;
}

/** The shape of a Resend webhook delivery this Worker reads; every other field is kept but not read. */
export interface ResendWebhookPayload {
  type: string;
  created_at: string;
  data: {
    email_id?: string;
    to?: string[];
    subject?: string;
    bounce?: { message?: string; type?: string; subType?: string };
    failed?: { reason?: string };
  };
}

/**
 * The recipient domains whose mail Cloudflare's routing already hands this Worker. A delivery event for
 * any other recipient is dropped unstored: Resend's webhook reports every send the account makes,
 * production's included, and a person's address does not belong in a test mailbox it never reached.
 */
const RECEIVED_DOMAINS = ['lumenize-test.dev', 'lumenize.io'];

/** How long mail and delivery events are kept: long enough to look into a failed run the next day. */
const RETENTION_DAYS = 14;
const RETENTION_SWEEP_EVERY_MS = 60 * 60_000;

/** Header name (lowercased — postal-mime exposes header keys lowercase). */
const INSTANCE_HEADER = 'x-lumenize-auth-instance';

/** Before 2026-10-08 each instance's mail was ONE KV array under this prefix, read and rewritten whole on every arrival. */
const LEGACY_KEY_PREFIX = 'emails:';
const LEGACY_NO_INSTANCE_KEY = `${LEGACY_KEY_PREFIX}<none>`;

/** Attachment shape persisted across WS hibernation via serializeAttachment. */
interface WsAttachment {
  /** Empty string means "match all" (broadcast subscriber, default). */
  instance: string;
  /** Set by `?events=1`. A socket that did not ask gets mail only, so an older client never sees an event. */
  events?: boolean;
}

export class EmailTestDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    // `seq` orders mail as it arrived, which `receivedAt` cannot: the clock does not advance within an invocation.
    sql.exec(`CREATE TABLE IF NOT EXISTS Emails (
      emailId TEXT PRIMARY KEY, instance TEXT NOT NULL, seq INTEGER NOT NULL, receivedAt TEXT NOT NULL, email TEXT NOT NULL
    ) WITHOUT ROWID`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_Emails_byInstance ON Emails (instance, seq)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS DeliveryEvents (
      recipient TEXT NOT NULL, eventId TEXT NOT NULL, receivedAt TEXT NOT NULL, event TEXT NOT NULL,
      PRIMARY KEY (recipient, eventId)
    ) WITHOUT ROWID`);
    this.migrateLegacyBuckets();
  }

  /**
   * Move mail stored the old way, one KV array per instance, into rows, then delete the arrays. A no-op
   * once they are gone. Mail past the retention window is not carried over.
   */
  migrateLegacyBuckets(): number {
    const legacy = [...this.ctx.storage.kv.list<StoredEmail[]>({ prefix: LEGACY_KEY_PREFIX })];
    if (legacy.length === 0) return 0;
    const cutoff = this.#retentionCutoff();
    const firstSeq = this.ctx.storage.kv.get<number>('emailSeq') ?? 0;
    let moved = 0;
    // One transaction, so a constructor cut short leaves the arrays to move again rather than half moved.
    this.ctx.storage.transactionSync(() => {
      for (const [key, emails] of legacy) {
        for (const email of emails ?? []) {
          if ((email.receivedAt ?? '') < cutoff) continue;
          moved++;
          this.#insertRow(email, key === LEGACY_NO_INSTANCE_KEY ? '' : key.slice(LEGACY_KEY_PREFIX.length), firstSeq + moved);
        }
        this.ctx.storage.kv.delete(key);
      }
      this.ctx.storage.kv.put('emailSeq', firstSeq + moved);
    });
    return moved;
  }

  /**
   * Accept a raw email (from the Worker's email() handler), parse it with
   * postal-mime, store it as a row (with its `X-Lumenize-Auth-Instance` header
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

    this.#insertEmail(stored, instance);
    this.#sweepIfDue();

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
   * Store what a verified Resend webhook delivery reports, one row per recipient this Worker receives
   * mail for, and push each to the sockets that asked for events. `eventId` is the delivery's `svix-id`,
   * which a retry repeats, so a retried delivery stores and pushes nothing new. Returns what was new.
   */
  receiveDeliveryEvent(eventId: string, payload: ResendWebhookPayload): DeliveryEvent[] {
    const receivedAt = new Date().toISOString();
    const reason = payload.data?.bounce?.message ?? payload.data?.bounce?.subType ?? payload.data?.failed?.reason;
    const fresh: DeliveryEvent[] = [];
    for (const to of payload.data?.to ?? []) {
      const recipient = to.toLowerCase();
      if (!RECEIVED_DOMAINS.includes(recipient.slice(recipient.lastIndexOf('@') + 1))) continue;
      const event: DeliveryEvent = {
        type: payload.type, recipient, emailId: payload.data.email_id ?? '', subject: payload.data.subject,
        occurredAt: payload.created_at, receivedAt, ...(reason ? { reason } : {}),
      };
      const cursor = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO DeliveryEvents (recipient, eventId, receivedAt, event) VALUES (?, ?, ?, ?)`,
        recipient, eventId, receivedAt, JSON.stringify(event),
      );
      if (cursor.rowsWritten > 0) fresh.push(event);
    }
    this.#sweepIfDue();
    for (const event of fresh) {
      const message = JSON.stringify({ kind: 'delivery-event', event } satisfies DeliveryEventMessage);
      for (const ws of this.ctx.getWebSockets()) {
        if ((ws.deserializeAttachment() as WsAttachment | null)?.events) ws.send(message);
      }
    }
    return fresh;
  }

  /** Every delivery event stored for `recipient`, oldest first. */
  getDeliveryEvents(recipient: string): DeliveryEvent[] {
    return [...this.ctx.storage.sql.exec<{ event: string }>(
      `SELECT event FROM DeliveryEvents WHERE recipient = ? ORDER BY receivedAt`, recipient.toLowerCase(),
    )].map((row) => JSON.parse(row.event) as DeliveryEvent);
  }

  /**
   * Return stored emails. With `instance` set, only emails whose
   * `X-Lumenize-Auth-Instance` header matched; otherwise everything.
   */
  getEmails(instance?: string): StoredEmail[] {
    const rows = instance !== undefined
      ? this.ctx.storage.sql.exec<{ email: string }>(`SELECT email FROM Emails WHERE instance = ? ORDER BY seq`, instance)
      : this.ctx.storage.sql.exec<{ email: string }>(`SELECT email FROM Emails ORDER BY seq`);
    return [...rows].map((row) => JSON.parse(row.email) as StoredEmail);
  }

  /**
   * Clear stored emails. With `instance` set, clears only that bucket;
   * otherwise wipes everything (current default — preserves existing
   * single-tenant callers).
   */
  clearEmails(instance?: string): void {
    if (instance !== undefined) {
      this.ctx.storage.sql.exec(`DELETE FROM Emails WHERE instance = ?`, instance);
      return;
    }
    this.ctx.storage.sql.exec(`DELETE FROM Emails`);
  }

  #insertEmail(email: StoredEmail, instance: string): void {
    const seq = (this.ctx.storage.kv.get<number>('emailSeq') ?? 0) + 1;
    this.ctx.storage.kv.put('emailSeq', seq);
    this.#insertRow(email, instance, seq);
  }

  #insertRow(email: StoredEmail, instance: string, seq: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO Emails (emailId, instance, seq, receivedAt, email) VALUES (?, ?, ?, ?, ?)`,
      crypto.randomUUID(), instance, seq, email.receivedAt, JSON.stringify(email),
    );
  }

  #retentionCutoff(): string {
    return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  }

  /** Delete mail and events past the retention window, at most once an hour. */
  #sweepIfDue(): void {
    const now = Date.now();
    const last = this.ctx.storage.kv.get<string>('lastSweepAt');
    if (last !== undefined && now - Date.parse(last) < RETENTION_SWEEP_EVERY_MS) return;
    this.ctx.storage.kv.put('lastSweepAt', new Date(now).toISOString());
    const cutoff = this.#retentionCutoff();
    this.ctx.storage.sql.exec(`DELETE FROM Emails WHERE receivedAt < ?`, cutoff);
    this.ctx.storage.sql.exec(`DELETE FROM DeliveryEvents WHERE receivedAt < ?`, cutoff);
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
      const attachment: WsAttachment = { instance, ...(url.searchParams.get('events') === '1' ? { events: true } : {}) };
      server.serializeAttachment(attachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/emails') {
      // ?instance= filters; absent → everything across all buckets
      const filter = url.searchParams.has('instance') ? instance : undefined;
      return Response.json(this.getEmails(filter));
    }

    if (url.pathname === '/events') {
      const to = url.searchParams.get('to');
      if (!to) return new Response('Name the recipient with ?to=', { status: 400 });
      return Response.json(this.getDeliveryEvents(to));
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
