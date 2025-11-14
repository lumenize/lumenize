/**
 * Call queue handler - processes queued call operations via alarms
 * 
 * This handler is called by alarms.schedule(0, ...) from call() to perform
 * async operations (storing continuation and sending RPC) without blocking.
 * 
 * The chains are already preprocessed by alarms when they arrive here.
 */

import { debug } from '@lumenize/core';
import { getDOStub } from '@lumenize/utils';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { CallMessage, PendingCall, CallOptions } from './types.js';
import type { OperationChain } from '@lumenize/core';

/**
 * Install the call queue handler into LumenizeBase
 * 
 * This overrides the placeholder __processCallQueue method with the actual implementation.
 * Called automatically when @lumenize/call is imported.
 * 
 * @internal
 */
export function installCallQueueHandler() {
  // Override LumenizeBase.__processCallQueue with actual implementation
  const LumenizeBaseProto = (globalThis as any).__LumenizeBasePrototype;
  
  if (!LumenizeBaseProto) {
    console.error('[CALL] Cannot install __processCallQueue: LumenizeBase.prototype not found!');
    return;
  }
  
  LumenizeBaseProto.__processCallQueue = processCallQueue;
}

/**
 * Process a queued call operation
 * 
 * Called by alarms - chains arrive already postprocessed by alarms' execution.
 * 
 * @param doInstance - The DO instance (bound as 'this')
 * @param remoteChain - Remote operation chain (already postprocessed by alarms)
 * @param continuationChain - Continuation chain (already postprocessed by alarms)
 * @param doBinding - Target DO binding name
 * @param doInstanceNameOrId - Target DO instance name or ID
 * @param options - Call options (timeout, etc.)
 * 
 * @internal
 */
async function processCallQueue(
  this: any,  // 'this' is the DO instance
  remoteChain: OperationChain,
  continuationChain: OperationChain,
  doBinding: string,
  doInstanceNameOrId: string,
  options?: CallOptions
): Promise<void> {
  const doInstance = this;
  const ctx = doInstance.ctx as DurableObjectState;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.call.processCallQueue');

  const operationId = crypto.randomUUID();
  const timeout = options?.timeout ?? 30000; // 30 seconds default

  log.debug('Processing queued call', {
    operationId,
    doBinding,
    doInstanceNameOrId,
    timeout
  });

  // Chains are already postprocessed by alarms - preprocess them for storage
  const preprocessedContinuation = await preprocess(continuationChain);

  // Store pending call with preprocessed continuation
  const pendingCall: PendingCall = {
    operationId,
    continuationChain: preprocessedContinuation,  // Store preprocessed version
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
  
  // Store pending call
  ctx.storage.kv.put(`__lmz_call_pending:${operationId}`, pendingCall);

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

  // Preprocess remote chain for transmission
  const preprocessedRemote = await preprocess(remoteChain);

  // Prepare message for remote DO
  const message: CallMessage = {
    originId: ctx.id.toString(),
    originBinding,
    originInstanceNameOrId: undefined, // Always use originId (ctx.id) for return address
    targetBinding: doBinding,
    targetInstanceNameOrId: doInstanceNameOrId,
    operationId,
    operationChain: preprocessedRemote  // Preprocessed for wire transmission
  };

  // Preprocess message for transmission
  const preprocessedMessage = await preprocess(message);

  try {
    // Send message to remote DO (Call 1: Origin → Remote)
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

