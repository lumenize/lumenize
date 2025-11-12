/**
 * @lumenize/call - Type-safe DO-to-DO communication
 * 
 * Enables remote method calls between Durable Objects using:
 * - OCAN (Operation Chaining And Nesting) for type-safe method chains
 * - Actor model with two one-way calls (minimize wall-clock time)
 * - Storage-based queues for fault tolerance
 * - Single continuation handler receives `Result | Error`
 * 
 * @example
 * ```typescript
 * import '@lumenize/call';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async doSomething() {
 *     const remote = this.ctn<RemoteDO>().getUserData(userId);
 *     
 *     await this.svc.call(
 *       'REMOTE_DO',
 *       'instance-id',
 *       remote,
 *       this.ctn().handleResult(remote)  // remote: UserData | Error
 *     );
 *   }
 *   
 *   handleResult(result: UserData | Error) {
 *     if (result instanceof Error) {
 *       console.error('Failed:', result);
 *       return;
 *     }
 *     console.log('Success:', result);
 *   }
 * }
 * ```
 */

export * from './types.js';
export { call, cancelCall } from './call.js';
export {
  __enqueueOperation,
  __processCallQueue,
  __receiveOperationResult,
  __handleCallAlarms
} from './receivers.js';

// Monkey-patch LumenizeBase with receiver methods
// This happens when @lumenize/call is imported
const patchLumenizeBase = () => {
  try {
    // Dynamic import to avoid circular dependencies
    import('@lumenize/lumenize-base').then(({ LumenizeBase }) => {
      if (LumenizeBase && LumenizeBase.prototype) {
        import('./receivers.js').then((receivers) => {
          LumenizeBase.prototype.__enqueueOperation = receivers.__enqueueOperation;
          LumenizeBase.prototype.__processCallQueue = receivers.__processCallQueue;
          LumenizeBase.prototype.__receiveOperationResult = receivers.__receiveOperationResult;
          LumenizeBase.prototype.__handleCallAlarms = receivers.__handleCallAlarms;
        });
      }
    }).catch(() => {
      // LumenizeBase not available - that's okay for standalone pattern
    });
  } catch (e) {
    // Ignore errors - might be in standalone mode
  }
};

// Run patching
patchLumenizeBase();

// Register call as a NADIS service
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}

// Call is a stateless function that takes parameters
(globalThis as any).__lumenizeServiceRegistry.call = (doInstance: any) => {
  return async (
    doBinding: string,
    instanceId: string,
    remoteOperation: any,
    continuation: any,
    options?: any
  ) => {
    const { call } = await import('./call.js');
    return call(doInstance, doBinding, instanceId, remoteOperation, continuation, options);
  };
};

// TypeScript declaration merging
declare global {
  interface LumenizeServices {
    call: (
      doBinding: string,
      instanceId: string,
      remoteOperation: any,
      continuation: any,
      options?: { timeout?: number }
    ) => Promise<void>;
  }
}
