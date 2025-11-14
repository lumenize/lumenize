import { debug, getOperationChain, type OperationChain, type DebugLogger } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { getDOStub } from '@lumenize/utils';
import '@lumenize/alarms';  // Import for NADIS registration
import type { CallOptions, CallMessage, PendingCall } from './types.js';

/**
 * Call - Type-safe DO-to-DO communication using Workers RPC
 * 
 * Implements an actor model with two one-way calls:
 * 1. Origin → Remote: Send operation (await receipt only)
 * 2. Remote → Origin: Send result (via callback)
 * 
 * This minimizes wall-clock time on the origin DO while ensuring fault
 * tolerance via persistent storage-based queues.
 * 
 * @param doInstance - The calling DO instance (provides ctx for storage/alarms)
 * @param doBinding - Name of the remote DO binding in env (e.g., 'REMOTE_DO')
 * @param doInstanceNameOrId - Name or ID of the remote DO instance (64-char hex = ID, else name)
 * @param remoteOperation - OCAN chain to execute on remote DO
 * @param continuation - OCAN chain for handling result (receives result | Error)
 * @param options - Optional configuration (timeout, etc.)
 * 
 * @example
 * ```typescript
 * import '@lumenize/call';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async fetch(request: Request) {
 *     // Auto-initialize binding info from headers
 *     await super.fetch(request);
 *     
 *     // Define remote operation
 *     const remote = this.ctn<RemoteDO>().getUserData(userId);
 *     
 *     // Call with continuation (named instance)
 *     await this.svc.call(
 *       'REMOTE_DO',           // binding name
 *       'my-instance',         // instance name
 *       remote,                // what to execute
 *       this.ctn().handleResult(remote),  // remote = result | Error
 *       { timeout: 30000 }     // optional
 *     );
 *     
 *     return new Response('OK');
 *   }
 *   
 *   handleResult(result: any | Error) {
 *     if (result instanceof Error) {
 *       console.error('Call failed:', result);
 *       return;
 *     }
 *     console.log('Got result:', result);
 *   }
 * }
 * ```
 */
export function call(
  doInstance: any,
  doBinding: string,
  doInstanceNameOrId: string,
  remoteOperation: any,
  continuation: any,
  options?: CallOptions
): void {
  const log = debug(doInstance.ctx)('lmz.call.call');

  // Extract operation chains (raw, not preprocessed yet)
  const remoteChain = getOperationChain(remoteOperation);
  const continuationChain = getOperationChain(continuation);

  if (!remoteChain) {
    throw new Error('Invalid remoteOperation: must be created with newContinuation() or this.ctn()');
  }
  if (!continuationChain) {
    throw new Error('Invalid continuation: must be created with newContinuation() or this.ctn()');
  }

  log.debug('Initiating call', {
    doBinding,
    doInstanceNameOrId,
    timeout: options?.timeout ?? 30000
  });

  // Generate unique ID for this call
  const callId = crypto.randomUUID();

  // Store call data in KV (for crash recovery and to avoid passing complex data through OCAN)
  const ctx = doInstance.ctx as DurableObjectState;
  ctx.storage.kv.put(`__lmz_call_data:${callId}`, {
    remoteChain,
    continuationChain,
    doBinding,
    doInstanceNameOrId,
    options
  });

  // Schedule immediate alarm (0 seconds) to process async work
  // Only pass the simple callId through OCAN (not complex chains!)
  doInstance.svc.alarms.schedule(
    0,  // Execute immediately (but after this method returns)
    doInstance.ctn().__processCallQueue(callId)
  );

  log.debug('Call queued via alarms', { callId });
}

/**
 * Cancel a pending call
 * 
 * Note: This only cancels the local continuation and timeout.
 * The remote DO may have already started executing the operation.
 * 
 * @param doInstance - The calling DO instance
 * @param operationId - ID of the operation to cancel
 * @returns true if cancelled, false if not found
 */
export function cancelCall(doInstance: any, operationId: string): boolean {
  const ctx = doInstance.ctx as DurableObjectState;
  const log = debug(ctx)('lmz.call.cancelCall');

  const key = `__lmz_call_pending:${operationId}`;
  const pendingData = ctx.storage.kv.get(key);
  
  if (!pendingData) {
    log.debug('Operation not found', { operationId });
    return false;
  }

  const pending = pendingData as PendingCall;

  // Remove pending call
  ctx.storage.kv.delete(key);

  // Remove timeout alarm if exists
  if (pending.timeoutAlarmId) {
    ctx.storage.kv.delete(pending.timeoutAlarmId);
  }

  log.debug('Call cancelled', { operationId });
  return true;
}

