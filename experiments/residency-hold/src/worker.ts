/**
 * Driver surface for {@link ResidencyProbe}, plus the SLEEPER the I/O arms wait on. Every
 * run addresses a FRESH instance name (the driver passes one) so arms never share an
 * isolate's history.
 *
 *   GET /fire?instance=X&arm=<Arm>&ms=240000[&aiMaxTokens=16000]  → kicks the detached work
 *   GET /status?instance=X                                         → markers + CURRENT boot id
 *   GET /sleep?ms=N  → answers after N ms (the pending-request arms)
 *   GET /drip?ms=N   → answers at once, then drips one byte every 5 s for N ms (fetchStream)
 *
 * The sleeper's own compatibility date is irrelevant to the measurement: what is measured
 * is whether the CALLING DO is held while its request to the sleeper is pending.
 */
import { ResidencyProbe, ARMS, type Arm } from './residency-probe';
export { ResidencyProbe };

const DRIP_EVERY_MS = 5_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ms = Number(url.searchParams.get('ms') ?? '240000');

    if (url.pathname === '/sleep') {
      await new Promise((r) => setTimeout(r, ms));
      return new Response(`slept ${ms}`);
    }
    if (url.pathname === '/drip') {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const drip = (async () => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          await writer.write(new Uint8Array([46]));
          await new Promise((r) => setTimeout(r, DRIP_EVERY_MS));
        }
        await writer.close();
      })();
      ctx.waitUntil(drip);
      return new Response(readable, { headers: { 'content-type': 'text/plain' } });
    }

    const instance = url.searchParams.get('instance');
    if (!instance) return new Response('instance required', { status: 400 });
    const stub = env.PROBE.getByName(instance);
    if (url.pathname === '/fire') {
      const armParam = url.searchParams.get('arm') as Arm;
      if (!ARMS.includes(armParam)) return new Response(`arm must be one of ${ARMS.join(', ')}`, { status: 400 });
      const aiMaxTokens = Number(url.searchParams.get('aiMaxTokens') ?? '16000');
      return Response.json(await stub.fire(armParam, ms, aiMaxTokens));
    }
    if (url.pathname === '/status') {
      return Response.json(await stub.status());
    }
    return new Response('not found', { status: 404 });
  },
};
