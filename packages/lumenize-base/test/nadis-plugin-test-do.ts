/**
 * Test DO for NadisPlugin tests
 * Separated from nadis-plugin.test.ts to avoid test lifecycle interference
 */

import { LumenizeBase } from '../src/index';

export class NadisPluginTestDO extends LumenizeBase<any> {
  async fetch(request: Request): Promise<Response> {
    await super.fetch(request);

    const url = new URL(request.url);

    if (url.pathname === '/check-access') {
      const service = this.svc.testService;
      return Response.json({
        hasCtx: !!service.getCtx(),
        hasSvc: !!service.getSvc(),
        hasDoInstance: !!service.getDoInstance(),
      });
    }

    if (url.pathname === '/increment') {
      const count = this.svc.testService.increment();
      return Response.json({ count });
    }

    if (url.pathname === '/use-helper') {
      const result = this.svc.testHelper('hello');
      return Response.json({ result });
    }

    if (url.pathname === '/use-service-with-deps') {
      // This will trigger service instantiation
      try {
        const service = (this.svc as any).serviceWithDeps;
        return Response.json({ ok: true });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : String(error),
          { status: 500 }
        );
      }
    }

    return new Response('Not Found', { status: 404 });
  }
}








