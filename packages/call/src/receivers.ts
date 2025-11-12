import { debug, executeOperationChain, type DebugLogger } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { CallMessage, CallResult } from './types.js';

/**
 * Enqueue an operation for execution on this DO (Actor Model - Call 1)
 * 
 * This method receives a message from a remote DO, stores it in a queue,
 * confirms receipt immediately (minimizing caller wall-clock time), then
 * processes the queue asynchronously.
 * 
 * @internal Called by @lumenize/call, not meant for direct use
 * @param message - The call message from the origin DO
 */
export async function __enqueueOperation(this: any, message: CallMessage): Promise<void> {
  const ctx = this.ctx as DurableObjectState;
  const log = debug(ctx)('lmz.call.__enqueueOperation');

  log.debug('Received operation', {
    operationId: message.operationId,
    originId: message.originId,
    originBinding: message.originBinding
  });

  // Store message in queue before confirming receipt
  const queueKey = `__call_queue:${message.operationId}`;
  const preprocessed = await preprocess(message);
  ctx.storage.kv.put(queueKey, JSON.stringify(preprocessed));

  // Confirm receipt immediately (actor model - don't await execution)
  // The caller can now return and minimize wall-clock time

  // Process queue asynchronously (after returning to caller)
  // Note: In DOs, we don't need ctx.waitUntil() - async ops are automatically awaited
  void this.__processCallQueue(message.operationId).catch((error: any) => {
    log.error('Error processing call queue', {
      operationId: message.operationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  });
}

/**
 * Process a queued operation
 * 
 * @internal
 * @param operationId - ID of the operation to process
 */
export async function __processCallQueue(this: any, operationId: string): Promise<void> {
  const ctx = this.ctx as DurableObjectState;
  const env = this.env;
  const log = debug(ctx)('lmz.call.__processCallQueue');

  const queueKey = `__call_queue:${operationId}`;
  const messageData = ctx.storage.kv.get(queueKey);

  if (!messageData) {
    log.error('Operation not found in queue', { operationId });
    return;
  }

  const preprocessed = JSON.parse(messageData as string);
  const message = await postprocess(preprocessed) as CallMessage;

  // Remove from queue now that we're processing
  ctx.storage.kv.delete(queueKey);

  let result: any;
  let error: Error | undefined;

  try {
    // Postprocess operation chain
    const operationChain = await postprocess(message.operationChain);

    log.debug('Executing operation chain', {
      operationId,
      operations: operationChain.length
    });

    // Execute the operation chain on this DO
    result = await executeOperationChain(operationChain, this);

    log.debug('Operation executed successfully', {
      operationId,
      resultType: typeof result
    });
  } catch (e) {
    // Execution failed - capture error
    error = e instanceof Error ? e : new Error(String(e));
    log.error('Operation execution failed', {
      operationId,
      error: error.message,
      stack: error.stack
    });
  }

  // Call back to origin DO with result (Actor Model - Call 2)
  try {
    const originStub = env[message.originBinding].idFromString(message.originId);
    const originDO = env[message.originBinding].get(originStub);

    const callResult: CallResult = {
      operationId,
      ...(error ? { error } : { result })
    };

    await originDO.__receiveOperationResult(callResult);
    log.debug('Result sent back to origin', { operationId });
  } catch (callbackError) {
    log.error('Failed to send result back to origin', {
      operationId,
      error: callbackError instanceof Error ? callbackError.message : String(callbackError),
      stack: callbackError instanceof Error ? callbackError.stack : undefined
    });
  }
}

/**
 * Receive an operation result from a remote DO (Actor Model - Call 2)
 * 
 * This method receives the result of a previously initiated call,
 * stores it, and schedules an immediate alarm to execute the continuation
 * handler with the result or error.
 * 
 * @internal Called by @lumenize/call, not meant for direct use
 * @param callResult - The result from the remote DO
 */
export async function __receiveOperationResult(this: any, callResult: CallResult): Promise<void> {
  const ctx = this.ctx as DurableObjectState;
  const log = debug(ctx)('lmz.call.__receiveOperationResult');

  const { operationId } = callResult;

  log.debug('Received operation result', {
    operationId,
    hasError: !!callResult.error,
    resultType: callResult.error ? 'error' : typeof callResult.result
  });

  // Retrieve pending call
  const pendingKey = `__call_pending:${operationId}`;
  const pendingData = ctx.storage.kv.get(pendingKey);

  if (!pendingData) {
    log.warn('Pending operation not found (may have been cancelled or timed out)', { operationId });
    return;
  }

  const pending = JSON.parse(pendingData as string);

  // Cancel timeout alarm if exists
  if (pending.timeoutAlarmId) {
    ctx.storage.kv.delete(pending.timeoutAlarmId);
  }

  // Store result for alarm handler
  const resultKey = `__call_result:${operationId}`;
  const preprocessedResult = await preprocess(callResult);
  ctx.storage.kv.put(resultKey, JSON.stringify(preprocessedResult));

  // Remove pending call
  ctx.storage.kv.delete(pendingKey);

  // Schedule immediate alarm to execute continuation
  const alarmKey = `__call_alarm:${operationId}`;
  ctx.storage.kv.put(alarmKey, JSON.stringify({ operationId, type: 'call_result' }));
  ctx.storage.setAlarm(Date.now()); // Immediate

  log.debug('Scheduled continuation alarm', { operationId });
}

/**
 * Handle call-related alarms (timeouts and result deliveries)
 * 
 * This should be called from the DO's alarm() handler.
 * 
 * @internal
 */
export async function __handleCallAlarms(this: any): Promise<void> {
  const ctx = this.ctx as DurableObjectState;
  const log = debug(ctx)('lmz.call.__handleCallAlarms');

  // Find all call-related alarms
  const alarmKeys = [...ctx.storage.kv.list({ prefix: '__call_alarm:' })];
  const timeoutKeys = [...ctx.storage.kv.list({ prefix: '__call_timeout:' })];

  for (const [key, value] of alarmKeys) {
    const alarmData = JSON.parse(value as string);
    const { operationId } = alarmData;

    // Get result
    const resultKey = `__call_result:${operationId}`;
    const resultData = ctx.storage.kv.get(resultKey);

    if (!resultData) {
      log.warn('Result not found for alarm', { operationId });
      ctx.storage.kv.delete(key);
      continue;
    }

    const preprocessed = JSON.parse(resultData as string);
    const callResult = await postprocess(preprocessed);

    // Get continuation chain from when the call was made
    const pendingKey = `__call_pending:${operationId}`;
    const pendingData = ctx.storage.kv.get(pendingKey);

    if (!pendingData) {
      // Already processed or cancelled
      ctx.storage.kv.delete(key);
      ctx.storage.kv.delete(resultKey);
      continue;
    }

    const pending = JSON.parse(pendingData as string);
    const continuationChain = await postprocess(pending.continuationChain);

    // Execute continuation with result or error
    try {
      const resultOrError = callResult.error ? callResult.error : callResult.result;
      
      // Replace placeholder with actual result
      const finalChain = replacePlaceholder(continuationChain, resultOrError);
      
      await executeOperationChain(finalChain, this);
      log.debug('Continuation executed', { operationId });
    } catch (error) {
      log.error('Continuation execution failed', {
        operationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }

    // Clean up
    ctx.storage.kv.delete(key);
    ctx.storage.kv.delete(resultKey);
  }

  // Handle timeouts
  for (const [key, value] of timeoutKeys) {
    const timeoutData = JSON.parse(value as string);
    const { operationId } = timeoutData;

    const pendingKey = `__call_pending:${operationId}`;
    const pendingData = ctx.storage.kv.get(pendingKey);

    if (!pendingData) {
      // Already completed or cancelled
      ctx.storage.kv.delete(key);
      continue;
    }

    const pending = JSON.parse(pendingData as string);
    const continuationChain = await postprocess(pending.continuationChain);

    // Execute continuation with timeout error
    try {
      const timeoutError = new Error(`Call timeout after ${pending.timeout || 30000}ms`);
      const finalChain = replacePlaceholder(continuationChain, timeoutError);
      
      await executeOperationChain(finalChain, this);
      log.debug('Timeout handler executed', { operationId });
    } catch (error) {
      log.error('Timeout handler failed', {
        operationId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Clean up
    ctx.storage.kv.delete(key);
    ctx.storage.kv.delete(pendingKey);
  }
}

/**
 * Replace placeholder in continuation chain with actual result
 * @internal
 */
function replacePlaceholder(chain: any[], resultOrError: any): any[] {
  // The placeholder is the remote operation itself
  // We need to replace it with the actual result
  // For now, we inject it as the first argument of the first apply operation
  return chain.map((op, i) => {
    if (op.type === 'apply' && i === chain.length - 1) {
      // Replace first arg with result
      return {
        ...op,
        args: [resultOrError, ...op.args.slice(1)]
      };
    }
    return op;
  });
}

