import { debug, getOperationChain, type OperationChain, type DebugLogger } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { getDOStub } from '@lumenize/utils';
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
export async function call(
  doInstance: any,
  doBinding: string,
  doInstanceNameOrId: string,
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
    doInstanceNameOrId,
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

  // Get remote DO stub (supports both names and IDs)
  const remoteStub = getDOStub(env[doBinding], doInstanceNameOrId);

  // Get origin binding name from storage
  const originBinding = ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
  
  if (!originBinding) {
    throw new Error(
      `Cannot use call() from a DO that doesn't know its own binding name. ` +
      `Call __lmzInit({ doBindingName }) first.`
    );
  }

  // Prepare message for remote DO
  // Note: originId always uses ctx.id (fast, no storage lookup)
  // originInstanceNameOrId is optional and only used for debugging
  const message: CallMessage = {
    originId: ctx.id.toString(),
    originBinding,
    originInstanceNameOrId: undefined, // Always use originId (ctx.id) for return address
    targetBinding: doBinding,
    targetInstanceNameOrId: doInstanceNameOrId,
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

