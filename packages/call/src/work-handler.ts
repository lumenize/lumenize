import { debug, executeOperationChain } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { CallMessage, CallResult } from './types.js';

/**
 * Work handler for 'call' work type
 * 
 * This is registered with LumenizeBase's work handler registry and
 * processes queued call operations.
 * 
 * @internal
 */
export async function callWorkHandler(
  doInstance: any,
  workId: string,
  workData: any
): Promise<void> {
  const ctx = doInstance.ctx as DurableObjectState;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.call.workHandler');

  // workData is the CallMessage (preprocessed)
  const message = await postprocess(workData) as CallMessage;

  log.debug('Processing call operation', {
    operationId: message.operationId,
    originId: message.originId,
    originBinding: message.originBinding
  });

  let result: any;
  let error: Error | undefined;

  try {
    // Postprocess operation chain
    const operationChain = await postprocess(message.operationChain);

    log.debug('Executing operation chain', {
      operationId: message.operationId,
      operations: operationChain.length
    });

    // Execute the operation chain on this DO
    result = await doInstance.__executeChain(operationChain);

    log.debug('Operation executed successfully', {
      operationId: message.operationId,
      resultType: typeof result
    });
  } catch (e) {
    // Execution failed - capture error
    error = e instanceof Error ? e : new Error(String(e));
    log.error('Operation execution failed', {
      operationId: message.operationId,
      error: error.message,
      stack: error.stack
    });
  }

  // Call back to origin DO with result (Actor Model - Call 2)
  try {
    const originId = env[message.originBinding].idFromString(message.originId);
    const originDO = env[message.originBinding].get(originId);

    const callResult: CallResult = {
      operationId: message.operationId,
      ...(error ? { error } : { result })
    };

    // Preprocess result before sending
    const preprocessedResult = await preprocess(callResult);

    await originDO.__receiveResult('call', message.operationId, preprocessedResult);
    log.debug('Result sent back to origin', { operationId: message.operationId });
  } catch (callbackError) {
    log.error('Failed to send result back to origin', {
      operationId: message.operationId,
      error: callbackError instanceof Error ? callbackError.message : String(callbackError),
      stack: callbackError instanceof Error ? callbackError.stack : undefined
    });
  }
}

