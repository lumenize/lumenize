/**
 * Driver surface for {@link ResidencyProbe}. Every run addresses a FRESH instance name
 * (the driver passes one) so arms never share an isolate's history.
 *
 *   GET /fire?instance=X&arm=held|control&ms=240000  → kicks the detached work, returns at once
 *   GET /status?instance=X                           → markers + the CURRENT boot id
 */
import { ResidencyProbe } from './residency-probe';
export { ResidencyProbe };

export default {
  async fetch(request: Request, env: { PROBE: DurableObjectNamespace<ResidencyProbe> }): Promise<Response> {
    const url = new URL(request.url);
    const instance = url.searchParams.get('instance');
    if (!instance) return new Response('instance required', { status: 400 });
    const stub = env.PROBE.getByName(instance);
    if (url.pathname === '/fire') {
      const arm = url.searchParams.get('arm') === 'held' ? 'held' : 'control';
      const ms = Number(url.searchParams.get('ms') ?? '240000');
      return Response.json(await stub.fire(arm, ms));
    }
    if (url.pathname === '/status') {
      return Response.json(await stub.status());
    }
    return new Response('not found', { status: 404 });
  },
};
