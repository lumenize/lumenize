import { DurableObject } from 'cloudflare:workers';

/**
 * Minimum repro: a DurableObject constructor that calls a side-effect
 * (console.log) inside the blockConcurrencyWhile IIFE before throwing.
 *
 * Observed:
 * - With the console.log line, vitest-pool-workers hangs at teardown after
 *   the assertion completes. The test itself passes.
 * - Removing the console.log line makes vitest exit cleanly (~300ms).
 * - In production (deployed to *.workers.dev), both variants behave
 *   identically — workerd evicts the broken DO and recreates it on the
 *   next request. No hang. No DOS. Other DO instances are unaffected.
 *
 * The hang is therefore in vitest-pool-workers's isolate teardown, not in
 * workerd's general handling of a broken input gate.
 */
export class BrokenDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      console.log('emit anything before the throw to trigger the hang');
      throw new Error('Intentional throw in blockConcurrencyWhile');
    });
  }

  async getValue(): Promise<string> {
    return 'never-reached';
  }
}

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('onstart-repro', { headers: { 'content-type': 'text/plain' } });
  },
} satisfies ExportedHandler<Env>;
