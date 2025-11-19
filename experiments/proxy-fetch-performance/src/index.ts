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
      ['direct', {
        name: 'Direct Fetch',
        description: 'Origin DO fetches directly (baseline)',
        handler: this.#runDirect.bind(this),
        strategy: 'sequential'
      }],
      ['current', {
        name: 'Current (proxyFetch)',
        description: 'proxyFetch with Orchestrator DO',
        handler: this.#runCurrent.bind(this),
        strategy: 'chained' // Fire-and-forget with chaining
      }],
      ['simple', {
        name: 'Simple (proxyFetchSimple)',
        description: 'proxyFetchSimple without Orchestrator',
        handler: this.#runSimple.bind(this),
        strategy: 'chained' // Fire-and-forget with chaining
      }],
    ]);
  }

  /**
   * Get test endpoints helper (lazy init)
   */
  #getTestEndpoints() {
    if (!this.#testEndpoints) {
      this.#testEndpoints = createTestEndpoints(
        this.env.TEST_TOKEN,
        'http://localhost:8787', // Base URL for local dev
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
    const url = endpoints.buildUrl('/delay/100');
    await originStub.fetchDirect(url, index);
  }

  /**
   * Current proxyFetch (with Orchestrator)
   * Chained execution - each completion triggers next operation
   */
  async #runCurrent(index: number, count?: number): Promise<void> {
    if (!count) throw new Error('Chained execution requires count parameter');
    
    const endpoints = this.#getTestEndpoints();
    const originStub = this.env.ORIGIN_DO.get(
      this.env.ORIGIN_DO.idFromName('origin-current')
    );

    const url = endpoints.buildUrl('/delay/100');
    
    // Start the chain - pass controller identity for RPC callback
    await originStub.startProxyFetchChain(url, count, 'current', 'CONTROLLER', 'controller');
  }

  /**
   * Simple proxyFetchSimple (without Orchestrator)
   * Chained execution - each completion triggers next operation
   */
  async #runSimple(index: number, count?: number): Promise<void> {
    if (!count) throw new Error('Chained execution requires count parameter');
    
    const endpoints = this.#getTestEndpoints();
    const originStub = this.env.ORIGIN_DO.get(
      this.env.ORIGIN_DO.idFromName('origin-simple')
    );

    const url = endpoints.buildUrl('/delay/100');
    
    // Start the chain - pass controller identity for RPC callback
    await originStub.startProxyFetchSimpleChain(url, count, 'simple', 'CONTROLLER', 'controller');
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
    // Kick off first operation
    // Parameters: $result (response), url, remaining, mode, controller identity
    proxyFetch(
      this,
      url,
      this.ctn().handleProxyFetchChainResult(this.ctn().$result, url, count, mode, controllerBindingName, controllerInstanceName)
    );
  }

  /**
   * Start proxyFetchSimple chain (returns immediately)
   * Countdown flows through continuation parameters
   */
  async startProxyFetchSimpleChain(url: string, count: number, mode: string, controllerBindingName: string, controllerInstanceName: string): Promise<void> {
    // Kick off first operation
    // Parameters: $result (response), url, remaining, mode, controller identity
    proxyFetchSimple(
      this,
      url,
      this.ctn().handleProxyFetchSimpleChainResult(this.ctn().$result, url, count, mode, controllerBindingName, controllerInstanceName)
    );
  }

  /**
   * Handle proxyFetch chain result
   * Continuation that decrements counter and kicks off next operation
   * Parameters flow through the chain: response, url, remaining, mode, controller identity
   */
  handleProxyFetchChainResult(response: any, url: string, remaining: number, mode: string, controllerBindingName: string, controllerInstanceName: string): void {
    // Check for errors
    if (response instanceof Error) {
      throw response; // Let the error propagate
    }
    if (!response?.ok) {
      throw new Error(`Fetch failed: ${response?.status || 'unknown'}`);
    }

    // Check if chain complete (this was the last operation)
    if (remaining === 1) {
      // Signal completion to controller via direct RPC
      // Note: signalChainedComplete is a simple void method, no continuation needed
      const namespace = this.env.CONTROLLER;
      const id = namespace.idFromName(controllerInstanceName);
      const stub = namespace.get(id);
      stub.signalChainedComplete(mode);
      return;
    }

    // Kick off next operation with decremented count
    proxyFetch(
      this,
      url,
      this.ctn().handleProxyFetchChainResult(this.ctn().$result, url, remaining - 1, mode, controllerBindingName, controllerInstanceName)
    );
  }

  /**
   * Handle proxyFetchSimple chain result
   * Continuation that decrements counter and kicks off next operation
   * Parameters flow through the chain: response, url, remaining, mode, controller identity
   */
  handleProxyFetchSimpleChainResult(response: any, url: string, remaining: number, mode: string, controllerBindingName: string, controllerInstanceName: string): void {
    // Check for errors
    if (response instanceof Error) {
      throw response; // Let the error propagate
    }
    if (!response?.ok) {
      throw new Error(`Fetch failed: ${response?.status || 'unknown'}`);
    }

    // Check if chain complete (this was the last operation)
    if (remaining === 1) {
      // Signal completion to controller via direct RPC
      // Note: signalChainedComplete is a simple void method, no continuation needed
      const namespace = this.env.CONTROLLER;
      const id = namespace.idFromName(controllerInstanceName);
      const stub = namespace.get(id);
      stub.signalChainedComplete(mode);
      return;
    }

    // Kick off next operation with decremented count
    proxyFetchSimple(
      this,
      url,
      this.ctn().handleProxyFetchSimpleChainResult(this.ctn().$result, url, remaining - 1, mode, controllerBindingName, controllerInstanceName)
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

