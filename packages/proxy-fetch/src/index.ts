/**
 * Proxy fetch for cost-effective external API calls from Durable Objects.
 * 
 * Uses a DO-Worker hybrid architecture where a Durable Object manages timing
 * and Workers perform CPU-billed fetch execution.
 * 
 * @module @lumenize/proxy-fetch
 */

// Main API
export { proxyFetch, type FetchMessage } from './proxy-fetch';

// Infrastructure components
export { FetchExecutorEntrypoint } from './fetch-executor-entrypoint';

// Types
export type { ProxyFetchWorkerOptions } from './types';

// Add __handleProxyFetchResult to LumenizeBase prototype
// This is called by both the worker (success) and alarm (timeout)
import { parse } from '@lumenize/structured-clone';
import { replaceNestedOperationMarkers } from '@lumenize/lumenize-base';

const LumenizeBasePrototype = (globalThis as any).__LumenizeBasePrototype;
if (LumenizeBasePrototype && !LumenizeBasePrototype.__handleProxyFetchResult) {
  LumenizeBasePrototype.__handleProxyFetchResult = async function(
    this: any,
    reqId: string,
    result: any,
    stringifiedUserContinuation?: string
  ): Promise<void> {
    // Try to cancel alarm - returns schedule if successful (we won the race)
    const scheduleData = this.svc.alarms.cancelSchedule(reqId);
    
    if (!scheduleData) {
      // Alarm already fired or already cancelled - this is a noop
      return;
    }
    
    // If not provided (worker path), extract from the cancelled alarm's operation chain
    let continuation = stringifiedUserContinuation;
    if (!continuation) {
      const lastOp = scheduleData.operationChain[scheduleData.operationChain.length - 1];
      if (!lastOp || lastOp.type !== 'apply' || !Array.isArray(lastOp.args) || lastOp.args.length < 3) {
        throw new Error(`Invalid alarm continuation for reqId ${reqId}: expected apply operation with 3 arguments`);
      }
      continuation = lastOp.args[2];
      if (typeof continuation !== 'string') {
        throw new Error(`Invalid alarm continuation for reqId ${reqId}: expected string but got ${typeof continuation}`);
      }
    }
    
    // We won the race - parse user's continuation, fill $result, and execute
    const userContinuation = parse(continuation);
    const filledChain = await replaceNestedOperationMarkers(userContinuation, result);
    await this.__executeChain(filledChain);
  };
}
