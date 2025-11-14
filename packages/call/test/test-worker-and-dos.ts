import { LumenizeBase } from '@lumenize/lumenize-base';
import '@lumenize/call';  // Import AFTER LumenizeBase so handler can be installed
import { enableAlarmSimulation } from '@lumenize/testing';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';

/**
 * RemoteDO - Target of remote calls
 * 
 * This DO receives calls from OriginDO and executes operations.
 */
export class RemoteDO extends LumenizeBase<Env> {
  #executedOperations: Array<{ method: string; args: any[] }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Enable alarm simulation for call's 0-second alarms
    enableAlarmSimulation(this, { timeScale: 100 });
  }

  // Test methods that can be called remotely
  getUserData(userId: string) {
    this.#executedOperations.push({ method: 'getUserData', args: [userId] });
    return { id: userId, name: 'Test User', email: 'test@example.com' };
  }

  add(a: number, b: number) {
    this.#executedOperations.push({ method: 'add', args: [a, b] });
    return a + b;
  }

  async asyncOperation(value: string) {
    this.#executedOperations.push({ method: 'asyncOperation', args: [value] });
    // Simulate async work
    await new Promise(resolve => setTimeout(resolve, 10));
    return `processed: ${value}`;
  }

  throwError(message: string) {
    this.#executedOperations.push({ method: 'throwError', args: [message] });
    throw new Error(message);
  }

  // Test helpers
  getExecutedOperations() {
    return this.#executedOperations;
  }

  clearExecutedOperations() {
    this.#executedOperations = [];
  }
}

/**
 * OriginDO - Initiates calls to remote DOs
 * 
 * This DO calls methods on RemoteDO and handles results.
 */
export class OriginDO extends LumenizeBase<Env> {
  #results: Array<{ type: 'success' | 'error'; value: any }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Enable alarm simulation for call's 0-second alarms
    enableAlarmSimulation(this, { timeScale: 100 });
  }

  // Test: Call remote method with continuation
  async callRemoteGetUserData(userId: string) {
    const remote = this.ctn<RemoteDO>().getUserData(userId);
    
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleUserDataResult(remote)
    );
  }

  handleUserDataResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test: Call remote math operation
  async callRemoteAdd(a: number, b: number) {
    const remote = this.ctn<RemoteDO>().add(a, b);
    
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleMathResult(remote),
    );
  }

  handleMathResult(result: number | Error) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test: Call remote operation that throws error
  async callRemoteThrowError(message: string) {
    const remote = this.ctn<RemoteDO>().throwError(message);
    
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleErrorResult(remote),
    );
  }

  handleErrorResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test: Call with timeout
  async callWithTimeout(value: string, timeout: number) {
    const remote = this.ctn<RemoteDO>().asyncOperation(value);
    
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleTimeoutResult(remote),
      { timeout }
    );
  }

  handleTimeoutResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test: Call with delay (for cancellation testing)
  // Note: Returns the callId (stored immediately), NOT operationId (created when alarm fires)
  async callRemoteWithDelay(value: string, delayMs: number): Promise<string> {
    const remote = this.ctn<RemoteDO>().asyncOperation(value);
    
    // Call returns void (synchronous), stores data and schedules alarm
    this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleDelayResult(remote),
    );
    
    // Return the callId (for immediate cancellation before alarm fires)
    // Don't trigger alarms here - let the test decide when
    const callData = [...this.ctx.storage.kv.list({ prefix: '__lmz_call_data:' })];
    if (callData.length === 0) {
      throw new Error('No call data found after call()');
    }
    const callId = callData[callData.length - 1][0].substring('__lmz_call_data:'.length);
    
    // Store mapping for cancellation (since tests expect to cancel by ID)
    // For now, just return the callId - tests will need to trigger alarms to get operationId
    return callId;
  }

  handleDelayResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test: Call with explicit timeout
  async callRemoteWithTimeout(value: string, timeout: number): Promise<string> {
    const remote = this.ctn<RemoteDO>().asyncOperation(value);
    
    // Call returns void (synchronous)
    this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleTimeoutTestResult(remote),
      { timeout }
    );
    
    // Trigger alarms to process the call and create the operationId
    await this.triggerAlarms();
    
    // Return operation ID
    const pending = [...this.ctx.storage.kv.list({ prefix: '__lmz_call_pending:' })];
    if (pending.length === 0) {
      throw new Error('No pending calls found after triggering alarms');
    }
    const lastKey = pending[pending.length - 1][0]; // [key, value] pairs
    return lastKey.substring('__lmz_call_pending:'.length);
  }

  handleTimeoutTestResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test: Cancel a pending call
  async cancelPendingCall(operationId: string): Promise<boolean> {
    // Use the cancelCall function from the call package
    const { cancelCall } = await import('@lumenize/call');
    return cancelCall(this, operationId);
  }

  // Test: Call with invalid remote operation (not OCAN)
  async callWithInvalidRemoteOperation() {
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      'not-an-ocan' as any, // Invalid!
      this.ctn().handleInvalidResult('never used'),
    );
  }

  // Test: Call with invalid continuation (not OCAN)
  async callWithInvalidContinuation() {
    const remote = this.ctn<RemoteDO>().add(1, 2);
    
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      'not-an-ocan' as any, // Invalid!
    );
  }

  handleInvalidResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test: Call a non-existent DO binding  
  async callNonExistentDO(value: string) {
    const remote = this.ctn<RemoteDO>().asyncOperation(value);
    
    // Use a non-existent binding name
    await this.svc.call(
      'NON_EXISTENT_BINDING',
      'test-instance',
      remote,
      this.ctn().handleResult(remote),
    );
  }

  // Test: Call with a continuation that throws
  async callRemoteWithThrowingContinuation(value: string) {
    const remote = this.ctn<RemoteDO>().asyncOperation(value);
    
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleThrowingResult(remote),
    );
  }

  handleThrowingResult(result: any) {
    // This handler intentionally throws to test error handling
    throw new Error('Intentional error in continuation handler');
  }

  // Test: Call without explicit init (should throw)
  async callWithoutInit(value: string) {
    const remote = this.ctn<RemoteDO>().asyncOperation(value);
    
    // This will throw because binding name is not initialized
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleResult(remote)
    );
  }

  // Generic result handler
  handleResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  // Test helpers
  getResults() {
    return this.#results;
  }

  clearResults() {
    this.#results = [];
  }

  async initializeBinding(bindingName: string, instanceNameOrId?: string) {
    await this.__lmzInit({ 
      doBindingName: bindingName,
      doInstanceNameOrId: instanceNameOrId || this.ctx.id.toString()
    });
  }

  // Manual alarm trigger for testing (bypasses native alarm system)
  async triggerAlarms() {
    if (this.svc?.alarms?.triggerAlarms) {
      return await this.svc.alarms.triggerAlarms();
    }
    return [];
  }

  async waitForResults(count: number, maxWait = 2000): Promise<void> {
    const startTime = Date.now();
    
    // Trigger alarms first (processes any queued 0-second alarms)
    await this.triggerAlarms();
    
    return new Promise((resolve, reject) => {
      const checkResults = () => {
        if (this.#results.length >= count) {
          resolve();
        } else if (Date.now() - startTime > maxWait) {
          reject(new Error(`Timeout waiting for ${count} results, got ${this.#results.length}`));
        } else {
          setTimeout(checkResults, 50);
        }
      };
      checkResults();
    });
  }
}

// Default export for worker
export default {
  async fetch(request: Request, env: Env) {
    return new Response('OK');
  },
};

