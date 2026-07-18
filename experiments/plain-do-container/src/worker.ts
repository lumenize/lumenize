export { PlainContainerDO } from './plain-container-do';

// Thin router so wrangler-dev can hit the DO methods by URL.
export default {
  async fetch(request: Request, env: { PLAIN_DO: DurableObjectNamespace }): Promise<Response> {
    const id = new URL(request.url).searchParams.get('id') ?? 'spike';
    const stub = env.PLAIN_DO.get(env.PLAIN_DO.idFromName(id)) as unknown as {
      ping(): Promise<string>;
      containerApiPresent(): Promise<unknown>;
      driveContainer(): Promise<string>;
      inspect(): Promise<unknown>;
      probe(ms?: number): Promise<unknown>;
      recover(): Promise<unknown>;
      runningNow(): Promise<unknown>;
      forceStart(): Promise<unknown>;
      attachMonitor(): Promise<unknown>;
      bootInfo(): Promise<unknown>;
      armAlarm(): Promise<unknown>;
      armTimeout(): Promise<unknown>;
      disarm(): Promise<unknown>;
      longAwait(ms: number): Promise<unknown>;
    };
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === '/boot') return Response.json(await stub.bootInfo());
    if (pathname === '/arm-alarm') return Response.json(await stub.armAlarm());
    if (pathname === '/arm-timeout') return Response.json(await stub.armTimeout());
    if (pathname === '/disarm') return Response.json(await stub.disarm());
    if (pathname === '/long-await') return Response.json(await stub.longAwait(Number(url.searchParams.get('ms') ?? '180000')));
    if (pathname === '/present') return Response.json(await stub.containerApiPresent());
    if (pathname === '/drive') return new Response(await stub.driveContainer());
    if (pathname === '/inspect') return Response.json(await stub.inspect());
    if (pathname === '/probe') return Response.json(await stub.probe());
    if (pathname === '/recover') return Response.json(await stub.recover());
    if (pathname === '/running') return Response.json(await stub.runningNow());
    if (pathname === '/force-start') return Response.json(await stub.forceStart());
    if (pathname === '/attach-monitor') return Response.json(await stub.attachMonitor());
    return new Response(await stub.ping());
  },
};
