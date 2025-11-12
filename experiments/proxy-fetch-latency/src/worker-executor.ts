/**
 * Worker Executor - Performs actual fetches with CPU billing
 * 
 * This is deployed as a separate worker (proxy-fetch-latency-worker)
 * and called via service binding from FetchOrchestrator.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { executeFetch } from '@lumenize/proxy-fetch';

interface Env {
  ORIGIN_DO: DurableObjectNamespace;
  FETCH_ORCHESTRATOR: DurableObjectNamespace;
  // Any other DO bindings needed for sending results back
}

/**
 * Worker entry point for fetch execution
 */
export default class extends WorkerEntrypoint<Env> {
  /**
   * HTTP fetch handler (required but not used - this worker is called via RPC)
   */
  async fetch(request: Request): Promise<Response> {
    return new Response('Worker Executor (called via RPC only)', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  /**
   * RPC method called by FetchOrchestrator
   * Executes the fetch and sends result directly to origin DO
   */
  async executeFetch(message: any): Promise<void> {
    return await executeFetch(message, this.env);
  }
}

