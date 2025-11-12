/**
 * Production Latency Measurement for proxyFetchWorker
 * 
 * This worker exports:
 * - OriginDO: Test DO that initiates fetches and measures latency
 * - FetchOrchestrator: Queue manager for dispatching to Workers
 * - Worker executor: CPU-billed fetch execution
 */

import { WorkerEntrypoint, DurableObjectState } from 'cloudflare:workers';
import { LumenizeBase } from '@lumenize/lumenize-base';
import { proxyFetchWorker, FetchOrchestrator as _FetchOrchestrator, executeFetch } from '@lumenize/proxy-fetch';
import '@lumenize/proxy-fetch'; // Register result handler

interface Env {
  ORIGIN_DO: DurableObjectNamespace;
  FETCH_ORCHESTRATOR: DurableObjectNamespace;
  FETCH_WORKER: FetchWorker;
}

interface FetchWorker {
  executeFetch(message: any): Promise<void>;
}

/**
 * Origin DO - Initiates fetches and measures latency
 */
export class OriginDO extends LumenizeBase<Env> {
  #results: Map<string, any> = new Map();
  #latencyMeasurements: Map<string, { startTime: number }> = new Map();

  /**
   * Handle HTTP requests to this DO
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/start-fetch') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const startTime = Date.now();
      
      const reqId = await proxyFetchWorker(
        this,
        targetUrl,
        this.ctn().handleFetchResult(this.ctn().$result),
        { originBinding: 'ORIGIN_DO' }
      );
      
      const enqueueTime = Date.now() - startTime;
      this.#latencyMeasurements.set(reqId, { startTime });
      
      return new Response(JSON.stringify({ reqId, enqueueTime }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/get-result') {
      const reqId = url.searchParams.get('reqId');
      if (!reqId) {
        return new Response(JSON.stringify({ error: 'Missing reqId parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const result = this.#results.get(reqId);
      return new Response(JSON.stringify(result || null), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/clear-results') {
      this.#results.clear();
      this.#latencyMeasurements.clear();
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Origin DO', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  /**
   * Handle fetch result (continuation)
   */
  async handleFetchResult(result: Response | Error) {
    const endTime = Date.now();
    
    // Get reqId from temporary storage (set by result handler)
    const reqId = this.ctx.storage.kv.get('__current_result_reqId') as string;
    
    if (!reqId) {
      console.error('No reqId found in storage');
      return;
    }
    
    const measurement = this.#latencyMeasurements.get(reqId);
    const duration = measurement ? endTime - measurement.startTime : 0;
    
    if (result instanceof Error) {
      this.#results.set(reqId, {
        success: false,
        error: result.message,
        duration
      });
    } else {
      const text = await result.text();
      this.#results.set(reqId, {
        success: true,
        status: result.status,
        responseLength: text.length,
        duration
      });
    }
    
    this.#latencyMeasurements.delete(reqId);
    this.ctx.storage.kv.delete('__current_result_reqId');
  }
}

/**
 * Re-export FetchOrchestrator
 */
export const FetchOrchestrator = _FetchOrchestrator;

/**
 * Worker entry point - routes requests to OriginDO
 */
export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Route all requests to the OriginDO
    const id = this.env.ORIGIN_DO.idFromName('latency-test');
    const stub = this.env.ORIGIN_DO.get(id);
    
    // Forward request to DO's fetch handler
    return await stub.fetch(request);
  }

  /**
   * RPC method for executing fetches (called by FetchOrchestrator)
   */
  async executeFetch(message: any): Promise<void> {
    return await executeFetch(message, this.env);
  }
}

