import { DurableObject } from 'cloudflare:workers';
import { ProxyFetchDO } from '../../src/ProxyFetchDurableObject';
import { proxyFetchDO } from '../../src/proxyFetch';
import { instrumentDOProject } from '@lumenize/testing';

/**
 * TestDO - Test DO for integration testing
 */
export class TestDO extends DurableObject {
  #results: Map<string, any> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Trigger a proxy fetch request from this DO
   */
  async triggerProxyFetch(url: string, handler?: string, options?: any): Promise<string> {
    return proxyFetchDO(this, url, 'TEST_DO', handler, options);
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

interface Env {
  PROXY_FETCH_DO: DurableObjectNamespace<ProxyFetchDO>;
  TEST_DO: DurableObjectNamespace<TestDO>;
  TEST_TOKEN: string;
  TEST_ENDPOINTS_URL: string;
}

// Use instrumentDOProject to wrap both DOs with RPC and create worker
const instrumented = instrumentDOProject({
  sourceModule: { ProxyFetchDO, TestDO },
  doClassNames: ['ProxyFetchDO', 'TestDO']
});

export const { ProxyFetchDO: InstrumentedProxyFetchDO, TestDO: InstrumentedTestDO } = instrumented.dos;
export default instrumented.worker;
