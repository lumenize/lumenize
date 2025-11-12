import { debug, getOperationChain, type OperationChain, type DebugLogger } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
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
 * @param instanceId - ID/name of the remote DO instance
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
 *   async doSomething() {
 *     // Define remote operation
 *     const remote = this.ctn<RemoteDO>().getUserData(userId);
 *     
 *     // Call with continuation
 *     await this.svc.call(
 *       'REMOTE_DO',           // binding name
 *       'instance-id',         // instance ID
 *       remote,                // what to execute
 *       this.ctn().handleResult(remote),  // remote = result | Error
 *       { timeout: 30000 }     // optional
 *     );
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
export async function call(
  doInstance: any,
  doBinding: string,
  instanceId: string,
  remoteOperation: any,
  continuation: any,
  options?: CallOptions
): Promise<void> {
  const ctx = doInstance.ctx as DurableObjectState;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.call.call');

  // Extract operation chains
  const remoteChain = getOperationChain(remoteOperation);
  const continuationChain = getOperationChain(continuation);

  if (!remoteChain) {
    throw new Error('Invalid remoteOperation: must be created with newContinuation() or this.ctn()');
  }
  if (!continuationChain) {
    throw new Error('Invalid continuation: must be created with newContinuation() or this.ctn()');
  }

  const operationId = crypto.randomUUID();
  const timeout = options?.timeout ?? 30000; // 30 seconds default

  log.debug('Initiating call', {
    operationId,
    doBinding,
    instanceId,
    timeout
  });

  // Store pending call in origin DO storage
  // Preprocess the continuation chain for storage
  const preprocessedContinuation = await preprocess(continuationChain);
  
  const pendingCall: PendingCall = {
    operationId,
    continuationChain: preprocessedContinuation,
    createdAt: Date.now()
  };

  // Schedule timeout alarm if timeout is set
  if (timeout > 0) {
    const timeoutAlarmId = `__lmz_call_timeout:${operationId}`;
    const timeoutTime = Date.now() + timeout;
    ctx.storage.setAlarm(timeoutTime);
    
    // Store timeout info
    ctx.storage.kv.put(timeoutAlarmId, {
      operationId,
      type: 'call_timeout'
    });
    
    // Add timeout alarm ID to pending call
    pendingCall.timeoutAlarmId = timeoutAlarmId;
  }
  
  // Store pending call with preprocessed continuation
  ctx.storage.kv.put(`__lmz_call_pending:${operationId}`, pendingCall);

  // Preprocess remote operation chain
  const preprocessedRemote = await preprocess(remoteChain);

  // Get remote DO stub
  const remoteId = env[doBinding].idFromName(instanceId);
  const remoteStub = env[doBinding].get(remoteId);

  // Prepare message for remote DO
  const originBinding = options?.originBinding || getOriginBinding(doInstance);
  const message: CallMessage = {
    originId: ctx.id.toString(),
    originBinding,
    operationId,
    operationChain: preprocessedRemote as OperationChain
  };

  // Preprocess message for transmission
  const preprocessedMessage = await preprocess(message);

  try {
    // Send message to remote DO (Call 1: Origin → Remote)
    // Only await receipt confirmation (not execution) - actor model
    await remoteStub.__enqueueWork('call', operationId, preprocessedMessage);
    log.debug('Operation enqueued on remote DO', { operationId });
  } catch (error) {
    // Failed to deliver message - clean up and throw
    ctx.storage.kv.delete(`__lmz_call_pending:${operationId}`);
    if (pendingCall.timeoutAlarmId) {
      ctx.storage.kv.delete(pendingCall.timeoutAlarmId);
    }
    throw new Error(`Failed to send call to remote DO: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get the binding name for this DO in the environment
 * @internal
 */
function getOriginBinding(doInstance: any): string {
  // Try to get from constructor name as fallback
  const constructorName = doInstance.constructor.name;
  
  // For LumenizeBase DOs, try to infer from env
  const env = doInstance.env;
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (value && typeof value === 'object' && 'idFromName' in value) {
        // This looks like a DO binding
        // Check if it matches our instance type
        if (value.constructor?.name === constructorName) {
          return key;
        }
      }
    }
  }
  
  // Fallback: Use constructor name
  // User may need to configure this explicitly in production
  return constructorName.replace(/DO$/, '_DO').toUpperCase();
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

