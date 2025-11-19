/**
 * Proxy-Fetch Performance Experiment
 * 
 * Compares latency and wall clock billing across:
 * - Direct: Origin DO fetches directly (baseline)
 * - Current: proxyFetch with Orchestrator DO
 * - Simple: proxyFetchSimple without Orchestrator DO
 */

import { LumenizeExperimentDO, type VariationDefinition } from '@lumenize/for-experiments';
import { proxyFetch, proxyFetchSimple, FetchOrchestrator, FetchExecutorEntrypoint } from '@lumenize/proxy-fetch';
import { TestEndpointsDO, createTestEndpoints } from '@lumenize/test-endpoints';
import { LumenizeBase } from '@lumenize/lumenize-base';
import { routeDORequest } from '@lumenize/utils';
import '@lumenize/alarms'; // NADIS plugin for proxyFetchSimple

/**
 * Performance Controller - Runs batch tests for proxy-fetch variations
 */
export class PerformanceController extends LumenizeExperimentDO<Env> {
  #testEndpoints: ReturnType<typeof createTestEndpoints> | null = null;

  protected getVariations(): Map<string, VariationDefinition> {
    return new Map([
      // ['direct', {
      //   name: 'Direct Fetch',
      //   description: 'Origin DO fetches directly (baseline)',
      //   handler: this.#runDirect.bind(this),
      //   strategy: 'sequential'
      // }],
      ['current', {
        name: 'Current (proxyFetch)',
        description: 'proxyFetch with Orchestrator DO',
        handler: this.#runCurrent.bind(this),
        strategy: 'chained'
      }],
      // ['simple', {
      //   name: 'Simple (proxyFetchSimple)',
      //   description: 'proxyFetchSimple without Orchestrator',
      //   handler: this.#runSimple.bind(this),
      //   strategy: 'chained'
      // }],
    ]);
  }

  /**
   * Get test endpoints helper (lazy init)
   */
  #getTestEndpoints() {
    if (!this.#testEndpoints) {
      // Use TEST_ENDPOINTS_URL if provided (for external testing)
      // Otherwise, use production URL for full URL construction (required by new Request())
      const baseUrl = this.env.TEST_ENDPOINTS_URL || 'https://test-endpoints.transformation.workers.dev';
      this.#testEndpoints = createTestEndpoints(
        this.env.TEST_TOKEN || '',
        baseUrl,
        'test'
      );
    }
    return this.#testEndpoints;
  }

  /**
   * Direct fetch (baseline)
   * Sequential execution - called for each index
   */
  async #runDirect(index: number): Promise<void> {
    const endpoints = this.#getTestEndpoints();
    
    // Get Origin DO stub
    const originStub = this.env.ORIGIN_DO.get(
      this.env.ORIGIN_DO.idFromName('origin-direct')
    );

    // Call Origin DO to do direct fetch
    const url = endpoints.buildUrl('/uuid');
    await originStub.fetchDirect(url, index);
  }

  /**
   * Current proxyFetch (with Orchestrator)
   * Chained execution - each completion triggers next operation
   */
  async #runCurrent(index: number, count?: number): Promise<void> {
    console.log('[PerformanceController] #runCurrent START:', { index, count });
    if (!count) throw new Error('Chained execution requires count parameter');
    
    const endpoints = this.#getTestEndpoints();
    console.log('[PerformanceController] Got endpoints');
    const originStub = this.env.ORIGIN_DO.get(
      this.env.ORIGIN_DO.idFromName('origin-current')
    );
    console.log('[PerformanceController] Got OriginDO stub');

    const url = endpoints.buildUrl('/uuid');
    console.log('[PerformanceController] Built URL:', url);
    
    // Start the chain - pass controller identity for RPC callback
    console.log('[PerformanceController] Calling startProxyFetchChain...');
    await originStub.startProxyFetchChain(url, count, 'current', 'CONTROLLER', 'controller');
    console.log('[PerformanceController] startProxyFetchChain returned');
  }

  /**
   * Simple proxyFetchSimple (without Orchestrator)
   * Chained execution - each completion triggers next operation
   */
  async #runSimple(index: number, count?: number): Promise<void> {
    console.log('[PerformanceController] #runSimple called:', { index, count });
    if (!count) throw new Error('Chained execution requires count parameter');
    
    const endpoints = this.#getTestEndpoints();
    const originStub = this.env.ORIGIN_DO.get(
      this.env.ORIGIN_DO.idFromName('origin-simple')
    );

    const url = endpoints.buildUrl('/uuid');
    console.log('[PerformanceController] Starting chain:', { url, count });
    
    // Start the chain - pass controller identity for RPC callback
    await originStub.startProxyFetchSimpleChain(url, count, 'simple', 'CONTROLLER', 'controller');
    console.log('[PerformanceController] Chain started (returned from startProxyFetchSimpleChain)');
  }
}

/**
 * Origin DO - Makes fetches using different methods
 */
export class OriginDO extends LumenizeBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Initialize LumenizeBase with binding name
    this.lmz.init({ bindingName: 'ORIGIN_DO' });
  }

  /**
   * Override fetch to handle timing test requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/debug/timing') {
      return this.testTiming();
    }
    
    return super.fetch(request);
  }

  /**
   * Test Date.now() vs performance.now() behavior in Workers
   */
  async testTiming(): Promise<Response> {
    const results: any = {
      description: "Comparing Date.now() vs performance.now() in Cloudflare Workers",
      tests: []
    };

    // Test 1: Synchronous loop
    const dateStart1 = Date.now();
    const perfStart1 = performance.now();
    
    let sum = 0;
    for (let i = 0; i < 1000000; i++) {
      sum += i;
    }
    
    const dateEnd1 = Date.now();
    const perfEnd1 = performance.now();
    
    results.tests.push({
      name: "Synchronous loop (1M iterations)",
      dateNowDelta: dateEnd1 - dateStart1,
      performanceNowDelta: perfEnd1 - perfStart1,
      result: sum
    });

    // Test 2: Fetch to external URL
    const dateStart2 = Date.now();
    const perfStart2 = performance.now();
    
    await fetch('https://test-endpoints.transformation.workers.dev/test-endpoints-do/test/uuid?token=8b169d0d-0ad0-4a62-ad64-79d218508041');
    
    const dateEnd2 = Date.now();
    const perfEnd2 = performance.now();
    
    results.tests.push({
      name: "External fetch (uuid endpoint)",
      dateNowDelta: dateEnd2 - dateStart2,
      performanceNowDelta: perfEnd2 - perfStart2
    });

    // Test 3: Storage operations
    const dateStart3 = Date.now();
    const perfStart3 = performance.now();
    
    this.ctx.storage.kv.put('timing-test', 'value');
    const value = this.ctx.storage.kv.get('timing-test');
    this.ctx.storage.kv.delete('timing-test');
    
    const dateEnd3 = Date.now();
    const perfEnd3 = performance.now();
    
    results.tests.push({
      name: "Storage operations (put/get/delete)",
      dateNowDelta: dateEnd3 - dateStart3,
      performanceNowDelta: perfEnd3 - perfStart3,
      value
    });

    // Test 4: Multiple sync operations
    const dateStart4 = Date.now();
    const perfStart4 = performance.now();
    
    const ops = [];
    for (let i = 0; i < 10; i++) {
      ops.push(JSON.stringify({ iteration: i, data: 'x'.repeat(100) }));
    }
    
    const dateEnd4 = Date.now();
    const perfEnd4 = performance.now();
    
    results.tests.push({
      name: "10 JSON.stringify operations",
      dateNowDelta: dateEnd4 - dateStart4,
      performanceNowDelta: perfEnd4 - perfStart4,
      operations: ops.length
    });

    results.summary = {
      dateNowUseful: results.tests.some((t: any) => t.dateNowDelta > 0),
      performanceNowUseful: results.tests.some((t: any) => t.performanceNowDelta > 0),
      recommendation: results.tests.some((t: any) => t.performanceNowDelta > 0) 
        ? "performance.now() advances, use it for timing"
        : "Neither advances - timing not possible during single execution"
    };

    return Response.json(results, {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Direct fetch (baseline)
   */
  async fetchDirect(url: string, index: number): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status}`);
    }
  }

  /**
   * Start proxyFetch chain (returns immediately)
   * Countdown flows through continuation parameters
   */
  async startProxyFetchChain(url: string, count: number, mode: string, controllerBindingName: string, controllerInstanceName: string): Promise<void> {
    console.log('[OriginDO] startProxyFetchChain:', { url, count, mode });
    
    // Kick off first operation (fire-and-forget, but catch errors)
    // Parameters: $result (response), url, remaining, total, mode, controller identity
    proxyFetch(
      this,
      url,
      this.ctn().handleProxyFetchChainResult(this.ctn().$result, url, count, count, mode, controllerBindingName, controllerInstanceName)
    ).catch(async (error) => {
      // Send error immediately to controller
      console.log('[OriginDO] Error in proxyFetch:', error);
      const controllerStub = this.env[controllerBindingName].get(this.env[controllerBindingName].idFromName(controllerInstanceName));
      await controllerStub.signalChainedError(mode, error instanceof Error ? error.message : String(error));
    });
    console.log('[OriginDO] proxyFetch called (fire-and-forget)');
  }

  /**
   * Start proxyFetchSimple chain (returns immediately)
   * Countdown flows through continuation parameters
   */
  async startProxyFetchSimpleChain(url: string, count: number, mode: string, controllerBindingName: string, controllerInstanceName: string): Promise<void> {
    console.log('[OriginDO] startProxyFetchSimpleChain:', { url, count, mode });
    
    // Kick off first operation (fire-and-forget, but catch errors)
    // Parameters: $result (response), url, remaining, total, mode, controller identity
    proxyFetchSimple(
      this,
      url,
      this.ctn().handleProxyFetchSimpleChainResult(this.ctn().$result, url, count, count, mode, controllerBindingName, controllerInstanceName)
    ).catch(async (error) => {
      // Send error immediately to controller
      console.log('[OriginDO] Error in proxyFetchSimple:', error);
      const controllerStub = this.env[controllerBindingName].get(this.env[controllerBindingName].idFromName(controllerInstanceName));
      await controllerStub.signalChainedError(mode, error instanceof Error ? error.message : String(error));
    });
    console.log('[OriginDO] proxyFetchSimple called (fire-and-forget)');
  }

  /**
   * Handle proxyFetch chain result
   * Continuation that decrements counter and kicks off next operation
   * Parameters flow through the chain: response, url, remaining, total, mode, controller identity
   */
  async handleProxyFetchChainResult(response: any, url: string, remaining: number, total: number, mode: string, controllerBindingName: string, controllerInstanceName: string): Promise<void> {
    console.log('[OriginDO] handleProxyFetchChainResult called:', { 
      hasResponse: !!response,
      isError: response instanceof Error,
      responseOk: response?.ok,
      remaining,
      total,
      mode
    });
    
    // Check for errors
    if (response instanceof Error) {
      console.log('[OriginDO] Response is Error, throwing');
      throw response; // Let the error propagate
    }
    if (!response?.ok) {
      console.log('[OriginDO] Response not ok, throwing');
      throw new Error(`Fetch failed: ${response?.status || 'unknown'}`);
    }

    // Check if chain complete (this was the last operation)
    if (remaining === 1) {
      console.log('[OriginDO] Chain complete (remaining=1), signaling controller');
      // Signal completion to controller via direct RPC
      // Note: signalChainedComplete is a simple void method, no continuation needed
      const namespace = this.env.CONTROLLER;
      const id = namespace.idFromName(controllerInstanceName);
      const stub = namespace.get(id);
      console.log('[OriginDO] Calling signalChainedComplete...');
      await stub.signalChainedComplete(mode, total);
      console.log('[OriginDO] signalChainedComplete returned');
      return;
    }

    console.log('[OriginDO] Continuing chain, kicking off next operation. Remaining:', remaining - 1);
    // Kick off next operation with decremented count
    proxyFetch(
      this,
      url,
      this.ctn().handleProxyFetchChainResult(this.ctn().$result, url, remaining - 1, total, mode, controllerBindingName, controllerInstanceName)
    );
    console.log('[OriginDO] proxyFetch called (fire-and-forget)');
  }

  /**
   * Handle proxyFetchSimple chain result
   * Continuation that decrements counter and kicks off next operation
   * Parameters flow through the chain: response, url, remaining, total, mode, controller identity
   */
  async handleProxyFetchSimpleChainResult(response: any, url: string, remaining: number, total: number, mode: string, controllerBindingName: string, controllerInstanceName: string): Promise<void> {
    console.log('[OriginDO] handleProxyFetchSimpleChainResult called:', { 
      hasResponse: !!response, 
      isError: response instanceof Error,
      responseOk: response?.ok,
      remaining,
      total,
      mode 
    });
    
    // Check for errors
    if (response instanceof Error) {
      console.log('[OriginDO] Error in chain:', response.message);
      throw response; // Let the error propagate
    }
    if (!response?.ok) {
      console.log('[OriginDO] Response not ok:', response?.status);
      throw new Error(`Fetch failed: ${response?.status || 'unknown'}`);
    }

    // Check if chain complete (this was the last operation)
    if (remaining === 1) {
      console.log('[OriginDO] Chain complete (remaining=1), signaling controller');
      // Signal completion to controller via direct RPC
      // Note: signalChainedComplete is a simple void method, no continuation needed
      const namespace = this.env.CONTROLLER;
      const id = namespace.idFromName(controllerInstanceName);
      const stub = namespace.get(id);
      await stub.signalChainedComplete(mode, total);
      console.log('[OriginDO] Controller signaled successfully');
      return;
    }

    console.log('[OriginDO] Continuing chain, kicking off next operation. Remaining:', remaining - 1);
    // Kick off next operation with decremented count
    proxyFetchSimple(
      this,
      url,
      this.ctn().handleProxyFetchSimpleChainResult(this.ctn().$result, url, remaining - 1, total, mode, controllerBindingName, controllerInstanceName)
    );
  }
}

/**
 * Export proxy-fetch DOs and Workers
 */
export { FetchOrchestrator, FetchExecutorEntrypoint };

/**
 * Export TestEndpointsDO from test-endpoints
 */
export { TestEndpointsDO };

/**
 * Worker - Routes requests to DOs based on URL path
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Debug endpoint to check environment
    if (url.pathname === '/debug/env') {
      const envInfo = {
        hasTestToken: !!env.TEST_TOKEN,
        hasTestEndpointsUrl: !!env.TEST_ENDPOINTS_URL,
        hasDebug: !!env.DEBUG,
        testTokenValue: env.TEST_TOKEN ? '***' + env.TEST_TOKEN.slice(-4) : undefined,
        testEndpointsUrlValue: env.TEST_ENDPOINTS_URL,
        debugValue: env.DEBUG,
        bindings: {
          hasController: !!env.CONTROLLER,
          hasOriginDo: !!env.ORIGIN_DO,
          hasFetchOrchestrator: !!env.FETCH_ORCHESTRATOR,
          hasTestEndpointsDo: !!env.TEST_ENDPOINTS_DO,
          hasFetchExecutor: !!env.FETCH_EXECUTOR,
        }
      };
      return Response.json(envInfo);
    }

    // Timing comparison endpoint
    if (url.pathname === '/debug/timing') {
      const stub = env.ORIGIN_DO.get(env.ORIGIN_DO.idFromName('timing-test'));
      return stub.fetch(request);
    }
    
    // Try routing to DOs first (test-endpoints-do, etc.)
    const doResponse = await routeDORequest(request, env);
    if (doResponse) {
      return doResponse;
    }
    
    // Default: route to Controller DO for WebSocket/patterns
    const id = env.CONTROLLER.idFromName('controller');
    const stub = env.CONTROLLER.get(id);
    return stub.fetch(request);
  }
};

