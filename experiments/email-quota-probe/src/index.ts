// GET /send?to=<address>[&from=<address>] — one send through the `send_email` binding, the same call
// shape as packages/email/src/cloudflare-email-transport.ts. Answers what the binding said.
interface EmailBinding {
  send(m: { from: { email: string; name: string }; to: string; subject: string; html: string }): Promise<unknown>;
}

export default {
  async fetch(request: Request, env: { EMAIL: EmailBinding }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/send') return new Response('GET /send?to=…', { status: 404 });
    const to = url.searchParams.get('to');
    if (!to) return new Response('to is required', { status: 400 });
    const from = url.searchParams.get('from') ?? 'noreply@lumenize.io';
    try {
      const result = await env.EMAIL.send({
        from: { email: from, name: 'Lumenize quota probe' },
        to,
        subject: `quota probe ${new Date().toISOString()}`,
        html: '<p>Quota experiment, 2026-10-03. Safe to ignore.</p>',
      });
      return Response.json({ ok: true, to, result });
    } catch (e) {
      return Response.json({ ok: false, to, error: String((e as Error)?.message ?? e) });
    }
  },
};
