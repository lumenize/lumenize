/**
 * @lumenize/call - Type-safe DO-to-DO communication
 * 
 * Enables remote method calls between Durable Objects using:
 * - OCAN (Operation Chaining And Nesting) for type-safe method chains
 * - Actor model with two one-way calls (minimize wall-clock time)
 * - Generic work queue infrastructure in LumenizeBase
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

// Import for registration
import { call } from './call.js';
import { callWorkHandler } from './work-handler.js';
import { callResultHandler } from './result-handler.js';
import { installCallQueueHandler } from './call-queue-handler.js';

// Install __processCallQueue handler into LumenizeBase
installCallQueueHandler();

// Register work handler for 'call' work type
if (!(globalThis as any).__lumenizeWorkHandlers) {
  (globalThis as any).__lumenizeWorkHandlers = {};
}
(globalThis as any).__lumenizeWorkHandlers.call = callWorkHandler;

// Register result handler for 'call' work type
if (!(globalThis as any).__lumenizeResultHandlers) {
  (globalThis as any).__lumenizeResultHandlers = {};
}
(globalThis as any).__lumenizeResultHandlers.call = callResultHandler;

// Register call as a NADIS service
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}

// Call is a function that returns a bound call with doInstance
// Capture call function in closure
const callFn = call;
(globalThis as any).__lumenizeServiceRegistry.call = (doInstance: any) => {
  return (
    doBinding: string,
    instanceId: string,
    remoteOperation: any,
    continuation: any,
    options?: any
  ) => {
    return callFn(doInstance, doBinding, instanceId, remoteOperation, continuation, options);
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
    ) => void;  // Synchronous! Returns immediately, processes via alarms
  }
}
