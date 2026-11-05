import { DurableObject } from 'cloudflare:workers';

/**
 * A minimal SQLite-backed DO used only to obtain a real `ctx.storage` handle in tests
 * (via `runInDurableObject`). It has no behavior of its own — the runner under test
 * operates on the storage handle, not on this class.
 */
export class SqlMigrationsTestDO extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response('ok');
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },
};
