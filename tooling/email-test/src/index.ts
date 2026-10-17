import { verifySvixSignature } from './svix-verify';
import type { ResendWebhookPayload } from './email-test-do';

export { EmailTestDO } from './email-test-do';
export { SimpleMimeMessage, createMimeMessage } from './simple-mime-message';
export type { StoredEmail, DeliveryEvent, DeliveryEventMessage } from './email-test-do';

const INSTANCE_NAME = 'email-inbox';

function checkTestToken(url: URL, env: Env): Response | null {
  const token = url.searchParams.get('token');
  if (!env.TEST_TOKEN || token !== env.TEST_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null;
}

/**
 * Reflect-and-allow CORS for the email-test worker. This worker is test-only
 * infrastructure (auth via TEST_TOKEN query param, not Origin) so permissive
 * CORS — including credentials — is fine. Real-browser test pages live on
 * `localhost:VITE_PORT` and need to fetch this worker cross-origin.
 */
function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    const m = request.headers.get('Access-Control-Request-Method');
    const h = request.headers.get('Access-Control-Request-Headers');
    if (m) headers.set('Access-Control-Allow-Methods', m);
    if (h) headers.set('Access-Control-Allow-Headers', h);
  }
  // Preserve `webSocket` on 101 upgrades (Vary'd CORS headers don't affect WS)
  const init: ResponseInit = { status: response.status, statusText: response.statusText, headers };
  if (response.webSocket) (init as ResponseInit & { webSocket?: WebSocket }).webSocket = response.webSocket;
  return new Response(response.body, init);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight short-circuit. CORS is permissive (test infra), so we
    // approve every preflight without consulting the DO.
    if (request.method === 'OPTIONS' && request.headers.get('Origin')) {
      return withCors(request, new Response(null, { status: 204 }));
    }

    // Resend's webhook: authenticated by its signature, since Resend cannot send TEST_TOKEN. Without the
    // secret it answers 503, which Resend retries, so deliveries made before the secret is set still land.
    if (url.pathname === '/resend-webhook' && request.method === 'POST') {
      const secret = (env as Env & { RESEND_WEBHOOK_SECRET?: string }).RESEND_WEBHOOK_SECRET;
      if (!secret) return new Response('webhook secret not configured', { status: 503 });
      const body = await request.text();
      if (!await verifySvixSignature(secret, request.headers, body)) return new Response('bad signature', { status: 401 });
      const stub = env.EMAIL_TEST_DO.getByName(INSTANCE_NAME);
      await stub.receiveDeliveryEvent(request.headers.get('svix-id')!, JSON.parse(body) as ResendWebhookPayload);
      return new Response('ok', { status: 200 });
    }

    // Route /ws, /emails, /events and /clear to the DO — all require TEST_TOKEN
    if (url.pathname === '/ws' || url.pathname === '/emails' || url.pathname === '/events' || url.pathname === '/clear') {
      const denied = checkTestToken(url, env);
      if (denied) return withCors(request, denied);

      const stub = env.EMAIL_TEST_DO.getByName(INSTANCE_NAME);
      const doResponse = await stub.fetch(request);
      return withCors(request, doResponse);
    }

    return withCors(request, new Response('email-test worker', { status: 200 }));
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const stub = env.EMAIL_TEST_DO.getByName(INSTANCE_NAME);
    const rawEmail = new Response(message.raw);
    const buffer = await rawEmail.arrayBuffer();
    await stub.receiveEmail(buffer);
  },
} satisfies ExportedHandler<Env>;
