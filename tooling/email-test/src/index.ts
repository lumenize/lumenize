export { EmailTestDO } from './email-test-do';
export { SimpleMimeMessage, createMimeMessage } from './simple-mime-message';
export type { StoredEmail } from './email-test-do';

const INSTANCE_NAME = 'email-inbox';

function checkTestToken(url: URL, env: Env): Response | null {
  const token = url.searchParams.get('token');
  if (!env.TEST_TOKEN || token !== env.TEST_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route /ws and /emails and /clear to the DO — all require TEST_TOKEN
    if (url.pathname === '/ws' || url.pathname === '/emails' || url.pathname === '/clear') {
      const denied = checkTestToken(url, env);
      if (denied) return denied;

      const stub = env.EMAIL_TEST_DO.getByName(INSTANCE_NAME);
      return stub.fetch(request);
    }

    return new Response('email-test worker', { status: 200 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const stub = env.EMAIL_TEST_DO.getByName(INSTANCE_NAME);
    const rawEmail = new Response(message.raw);
    const buffer = await rawEmail.arrayBuffer();
    await stub.receiveEmail(buffer);
  },
} satisfies ExportedHandler<Env>;
