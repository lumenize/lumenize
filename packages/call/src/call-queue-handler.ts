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
 * Called by alarms with a callId. Retrieves call data from storage,
 * processes it, and sends to remote DO.
 * 
 * @param doInstance - The DO instance (bound as 'this')
 * @param callId - Unique identifier for this call (stored in __lmz_call_data:{callId})
 * 
 * @internal
 */
async function processCallQueue(
  this: any,  // 'this' is the DO instance
  callId: string
): Promise<void> {
  const doInstance = this;
  const ctx = doInstance.ctx as DurableObjectState;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.call.processCallQueue');

  log.debug('Processing queued call', { callId });

  // Retrieve call data from storage
  const callData = ctx.storage.kv.get(`__lmz_call_data:${callId}`) as {
    remoteChain: OperationChain;
    continuationChain: OperationChain;
    doBinding: string;
    doInstanceNameOrId: string;
    options?: CallOptions;
  } | undefined;

  if (!callData) {
    log.error('Call data not found in storage', { callId });
    throw new Error(`Call data not found for callId: ${callId}`);
  }

  // Clean up the call data now that we've retrieved it
  ctx.storage.kv.delete(`__lmz_call_data:${callId}`);

  const { remoteChain, continuationChain, doBinding, doInstanceNameOrId, options } = callData;

  const operationId = crypto.randomUUID();
  const timeout = options?.timeout ?? 30000; // 30 seconds default

  log.debug('Call data retrieved', {
    operationId,
    doBinding,
    doInstanceNameOrId,
    timeout
  });

  // Preprocess chains for storage and transmission
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

