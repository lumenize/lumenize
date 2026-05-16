import { DurableObject } from 'cloudflare:workers';
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc';

export interface CompileSFCResult {
  script: string;
  template: string;
  styles: string[];
  errors: string[];
}

export class SpikeGalaxy extends DurableObject<Env> {
  compileSFC(sfcSource: string, id: string = 'spike'): CompileSFCResult {
    const errors: string[] = [];

    const parseResult = parse(sfcSource);
    if (parseResult.errors.length > 0) {
      errors.push(...parseResult.errors.map((e) => String(e.message ?? e)));
      return { script: '', template: '', styles: [], errors };
    }
    const { descriptor } = parseResult;

    let script = '';
    if (descriptor.script || descriptor.scriptSetup) {
      try {
        const scriptResult = compileScript(descriptor, { id });
        script = scriptResult.content;
      } catch (err) {
        errors.push(`compileScript: ${(err as Error).message}`);
      }
    }

    let template = '';
    if (descriptor.template) {
      try {
        const templateResult = compileTemplate({
          source: descriptor.template.content,
          filename: `${id}.vue`,
          id,
        });
        template = templateResult.code;
        if (templateResult.errors.length > 0) {
          errors.push(
            ...templateResult.errors.map((e) => `compileTemplate: ${typeof e === 'string' ? e : e.message}`),
          );
        }
      } catch (err) {
        errors.push(`compileTemplate: ${(err as Error).message}`);
      }
    }

    const styles: string[] = [];
    for (const styleBlock of descriptor.styles) {
      try {
        const styleResult = compileStyle({
          source: styleBlock.content,
          filename: `${id}.vue`,
          id,
          scoped: styleBlock.scoped,
        });
        styles.push(styleResult.code);
        if (styleResult.errors.length > 0) {
          errors.push(...styleResult.errors.map((e) => `compileStyle: ${e.message}`));
        }
      } catch (err) {
        errors.push(`compileStyle: ${(err as Error).message}`);
      }
    }

    return { script, template, styles, errors };
  }

  /**
   * Handle HTTP/WS requests forwarded from the Worker entrypoint.
   *
   * Routes:
   *   GET  /galaxy/spike/reload/{sessionId}    (Upgrade: websocket)  — register preview client
   *   POST /galaxy/spike/compile/{sessionId}                          — compile + broadcast 'reload'
   *
   * Production design note: this path-action routing exists because the
   * standalone spike doesn't have a NebulaClient driving compile via
   * `lmz.call`. In production, only the WS upgrade route would remain;
   * compile would arrive over the mesh as an `@mesh()` method call.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    // Expected shape after routeDORequest hands it off:
    //   parts = ['galaxy', 'spike', action, sessionId]
    const action = parts[2];
    const sessionId = parts[3];

    if (!action || !sessionId) {
      return new Response('Bad request: missing action or sessionId', { status: 400 });
    }

    if (action === 'reload' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.#handleReloadUpgrade(sessionId);
    }

    if (action === 'compile' && request.method === 'POST') {
      return this.#handleCompile(request, sessionId);
    }

    return new Response('Not found', { status: 404 });
  }

  #handleReloadUpgrade(sessionId: string): Response {
    const pair = new WebSocketPair();
    // Hibernation API: tag the server-side WS with sessionId so we can
    // address it via getWebSockets(sessionId) when broadcasting reload.
    this.ctx.acceptWebSocket(pair[1], [sessionId]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async #handleCompile(request: Request, sessionId: string): Promise<Response> {
    const sfcSource = await request.text();
    const compiled = this.compileSFC(sfcSource, sessionId);

    // Broadcast 'reload' to every preview client subscribed to this sessionId.
    const peers = this.ctx.getWebSockets(sessionId);
    for (const ws of peers) {
      ws.send('reload');
    }

    // No `Date.now()` timings in the response — `Date.now()` is pinned
    // within a single DO invocation, so inner timings would all read 0.
    // Wall-clock measurements happen from outside the Workers runtime in
    // the follow-on node.js + wrangler-dev phase.
    return Response.json({
      compiled: {
        script: compiled.script.length,
        template: compiled.template.length,
        styles: compiled.styles.length,
        errors: compiled.errors,
      },
      notifiedPeers: peers.length,
    });
  }

  // Hibernation API requires these to be defined even if no-op.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // No-op for spike — preview clients only listen, never send.
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // No-op for spike — the WS is implicitly removed from the tag's set
    // when its connection closes.
  }
}
