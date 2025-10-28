import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
import { ProxyFetchDO } from '../../src/ProxyFetchDurableObject';

// Re-export ProxyFetchDO for wrangler bindings
export { ProxyFetchDO };

/**
 * TestDO - Test DO for integration testing
 */
export class TestDO extends DurableObject {
  #results: Map<string, any> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async handleSuccess(item: any): Promise<void> {
    console.log('TestDO.handleSuccess:', item.reqId);
    this.#results.set(item.reqId, { success: true, item });
  }

  async handleError(item: any): Promise<void> {
    console.log('TestDO.handleError:', item.reqId);
    this.#results.set(item.reqId, { success: false, item });
  }

  async getResult(reqId: string): Promise<any> {
    return this.#results.get(reqId);
  }

  async reset(): Promise<void> {
    this.#results.clear();
  }
}

/**
 * Worker entrypoint for testing
 */
export default class TestWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return new Response('Test worker for ProxyFetchDO');
  }
}

interface Env {
  PROXY_FETCH_DO: DurableObjectNamespace<ProxyFetchDO>;
  TEST_DO: DurableObjectNamespace<TestDO>;
  TEST_TOKEN: string;
  TEST_ENDPOINTS_URL: string;
}
