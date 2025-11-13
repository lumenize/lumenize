import { LumenizeBase } from '@lumenize/lumenize-base';
import '@lumenize/call';  // Auto-registers call service via NADIS

export interface Env {
  ORIGIN_DO: DurableObjectNamespace<OriginDO>;
  REMOTE_DO: DurableObjectNamespace<RemoteDO>;
}

/**
 * RemoteDO - Receives and executes operations
 */
export class RemoteDO extends LumenizeBase<Env> {
  #executedOperations: string[] = [];

  getUserData(userId: string) {
    this.#executedOperations.push('getUserData');
    return {
      userId,
      name: 'Test User',
    };
  }

  add(a: number, b: number): number {
    this.#executedOperations.push('add');
    return a + b;
  }

  throwError(message: string): never {
    this.#executedOperations.push('throwError');
    throw new Error(message);
  }

  slowOperation(delayMs: number) {
    this.#executedOperations.push('slowOperation');
    const start = Date.now();
    while (Date.now() - start < delayMs) {
      // Busy wait
    }
    return 'processed: slow-operation';
  }

  getExecutedOperations() {
    return this.#executedOperations;
  }

  clearExecutedOperations() {
    this.#executedOperations = [];
  }
}

/**
 * OriginDO - Makes calls to remote DOs
 * 
 * These example methods show the full call system API in action.
 */
export class OriginDO extends LumenizeBase<Env> {
  #results: Array<{ type: 'success' | 'error'; value: any }> = [];

  // Example: Basic remote call
  async exampleBasicCall(userId: string) {
    await this.svc.call(
      'REMOTE_DO',                          // DO binding name
      'remote-1',                           // Instance ID
      this.ctn<RemoteDO>().getUserData(userId),  // Remote operation
      this.ctn().handleUserDataResult(this.ctn().$result),  // Continuation
      { originBinding: 'ORIGIN_DO' }        // Options
    );
  }

  // Example: Calling a method that throws
  async exampleErrorHandling(message: string) {
    await this.svc.call(
      'REMOTE_DO',
      'remote-1',
      this.ctn<RemoteDO>().throwError(message),
      this.ctn().handleUserDataResult(this.ctn().$result),
      { originBinding: 'ORIGIN_DO' }
    );
  }

  // Example: Using timeout option
  async exampleWithTimeout(delayMs: number, timeoutMs: number) {
    await this.svc.call(
      'REMOTE_DO',
      'remote-1',
      this.ctn<RemoteDO>().slowOperation(delayMs),
      this.ctn().handleUserDataResult(this.ctn().$result),
      { timeout: timeoutMs, originBinding: 'ORIGIN_DO' }
    );
  }

  // Example: Math operation with typed handler
  async exampleMathOperation(a: number, b: number) {
    await this.svc.call(
      'REMOTE_DO',
      'remote-1',
      this.ctn<RemoteDO>().add(a, b),
      this.ctn().handleMathResult(this.ctn().$result),
      { originBinding: 'ORIGIN_DO' }
    );
  }

  // Continuation handlers - called when results arrive

  handleUserDataResult(result: any) {
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message });
    } else {
      this.#results.push({ type: 'success', value: result });
    }
  }

  handleMathResult(result: number | Error) {
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
}

