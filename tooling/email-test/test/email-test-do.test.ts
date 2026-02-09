import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createMimeMessage } from '../src/simple-mime-message';

describe('EmailTestDO', () => {
  describe('email parsing and KV storage', () => {
    it('parses a plain text email and stores it in KV', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('parse-text-1');

      const mime = createMimeMessage()
        .setSender({ name: 'Lumenize', addr: 'auth@lumenize.com' })
        .setRecipient('test.email@lumenize.com')
        .setSubject('Your login link')
        .addMessage({ contentType: 'text/plain', data: 'Click here to log in: https://example.com/magic' });

      const raw = mime.asRaw();
      const buffer = new TextEncoder().encode(raw).buffer;
      const stored = await stub.receiveEmail(buffer);

      expect(stored.subject).toBe('Your login link');
      expect(stored.from?.address).toBe('auth@lumenize.com');
      expect(stored.from?.name).toBe('Lumenize');
      expect(stored.to?.[0]?.address).toBe('test.email@lumenize.com');
      expect(stored.text).toContain('Click here to log in');
      expect(stored.receivedAt).toBeDefined();
    });

    it('parses an HTML email and stores it in KV', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('parse-html-1');

      const html = '<h1>Welcome</h1><a href="https://example.com/magic?token=abc123">Sign in</a>';
      const mime = createMimeMessage()
        .setSender({ name: 'My App', addr: 'auth@myapp.com' })
        .setRecipient('user@example.com')
        .setSubject('Sign in to My App')
        .addMessage({ contentType: 'text/html', data: html });

      const raw = mime.asRaw();
      const buffer = new TextEncoder().encode(raw).buffer;
      const stored = await stub.receiveEmail(buffer);

      expect(stored.subject).toBe('Sign in to My App');
      expect(stored.html).toContain('href="https://example.com/magic?token=abc123"');
      expect(stored.from?.name).toBe('My App');
    });

    it('accumulates multiple emails in KV array', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('accumulate-1');

      for (let i = 1; i <= 3; i++) {
        const mime = createMimeMessage()
          .setSender({ addr: `sender${i}@example.com` })
          .setRecipient('inbox@example.com')
          .setSubject(`Email ${i}`)
          .addMessage({ contentType: 'text/plain', data: `Body ${i}` });

        const buffer = new TextEncoder().encode(mime.asRaw()).buffer;
        await stub.receiveEmail(buffer);
      }

      const emails = await stub.getEmails();
      expect(emails).toHaveLength(3);
      expect(emails[0].subject).toBe('Email 1');
      expect(emails[1].subject).toBe('Email 2');
      expect(emails[2].subject).toBe('Email 3');
    });

    it('clears emails', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('clear-1');

      const mime = createMimeMessage()
        .setSender({ addr: 'sender@example.com' })
        .setRecipient('inbox@example.com')
        .setSubject('To be cleared')
        .addMessage({ contentType: 'text/plain', data: 'Temporary' });

      const buffer = new TextEncoder().encode(mime.asRaw()).buffer;
      await stub.receiveEmail(buffer);

      let emails = await stub.getEmails();
      expect(emails).toHaveLength(1);

      await stub.clearEmails();

      emails = await stub.getEmails();
      expect(emails).toHaveLength(0);
    });
  });

  describe('WebSocket push', () => {
    it('pushes parsed email to connected WebSocket clients', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('ws-push-1');

      // Connect WebSocket
      const response = await stub.fetch('https://email-test/ws', {
        headers: { 'Upgrade': 'websocket' },
      });
      expect(response.status).toBe(101);

      const ws = response.webSocket!;
      ws.accept();

      // Set up message listener before sending email
      const messagePromise = new Promise<any>((resolve) => {
        ws.addEventListener('message', (event) => {
          resolve(JSON.parse(event.data as string));
        });
      });

      // Send email to the DO
      const mime = createMimeMessage()
        .setSender({ name: 'Auth Service', addr: 'auth@lumenize.com' })
        .setRecipient('test.email@lumenize.com')
        .setSubject('Your login link')
        .addMessage({
          contentType: 'text/html',
          data: '<a href="https://example.com/auth/magic?token=xyz">Sign in</a>',
        });

      const buffer = new TextEncoder().encode(mime.asRaw()).buffer;
      await stub.receiveEmail(buffer);

      // Verify WebSocket received the parsed email
      const pushed = await messagePromise;
      expect(pushed.subject).toBe('Your login link');
      expect(pushed.from.address).toBe('auth@lumenize.com');
      expect(pushed.from.name).toBe('Auth Service');
      expect(pushed.html).toContain('token=xyz');

      ws.close();
    });

    it('pushes to multiple connected clients', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('ws-push-multi-1');

      // Connect two WebSocket clients
      const responses = await Promise.all([
        stub.fetch('https://email-test/ws', { headers: { 'Upgrade': 'websocket' } }),
        stub.fetch('https://email-test/ws', { headers: { 'Upgrade': 'websocket' } }),
      ]);

      const sockets = responses.map((r) => {
        expect(r.status).toBe(101);
        const ws = r.webSocket!;
        ws.accept();
        return ws;
      });

      // Set up message listeners
      const messagePromises = sockets.map(
        (ws) =>
          new Promise<any>((resolve) => {
            ws.addEventListener('message', (event) => {
              resolve(JSON.parse(event.data as string));
            });
          }),
      );

      // Send email
      const mime = createMimeMessage()
        .setSender({ addr: 'sender@example.com' })
        .setRecipient('inbox@example.com')
        .setSubject('Broadcast test')
        .addMessage({ contentType: 'text/plain', data: 'Hello everyone' });

      const buffer = new TextEncoder().encode(mime.asRaw()).buffer;
      await stub.receiveEmail(buffer);

      // Both clients should receive the push
      const results = await Promise.all(messagePromises);
      for (const pushed of results) {
        expect(pushed.subject).toBe('Broadcast test');
      }

      for (const ws of sockets) ws.close();
    });
  });

  describe('HTTP endpoints', () => {
    it('GET /emails returns stored emails', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('http-emails-1');

      const mime = createMimeMessage()
        .setSender({ addr: 'sender@example.com' })
        .setRecipient('inbox@example.com')
        .setSubject('HTTP test')
        .addMessage({ contentType: 'text/plain', data: 'Via HTTP' });

      const buffer = new TextEncoder().encode(mime.asRaw()).buffer;
      await stub.receiveEmail(buffer);

      const response = await stub.fetch('https://email-test/emails');
      expect(response.status).toBe(200);

      const emails = await response.json() as any[];
      expect(emails).toHaveLength(1);
      expect(emails[0].subject).toBe('HTTP test');
    });

    it('POST /clear clears stored emails', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('http-clear-1');

      const mime = createMimeMessage()
        .setSender({ addr: 'sender@example.com' })
        .setRecipient('inbox@example.com')
        .setSubject('To clear')
        .addMessage({ contentType: 'text/plain', data: 'Will be cleared' });

      const buffer = new TextEncoder().encode(mime.asRaw()).buffer;
      await stub.receiveEmail(buffer);

      const clearResponse = await stub.fetch('https://email-test/clear', { method: 'POST' });
      expect(clearResponse.status).toBe(200);

      const emailsResponse = await stub.fetch('https://email-test/emails');
      const emails = await emailsResponse.json() as any[];
      expect(emails).toHaveLength(0);
    });

    it('returns 400 for non-WebSocket request to /ws', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('http-ws-reject-1');

      const response = await stub.fetch('https://email-test/ws');
      expect(response.status).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const stub = env.EMAIL_TEST_DO.getByName('http-404-1');

      const response = await stub.fetch('https://email-test/unknown');
      expect(response.status).toBe(404);
    });
  });
});
