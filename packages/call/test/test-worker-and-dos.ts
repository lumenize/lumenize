import '@lumenize/call';
import { LumenizeBase } from '@lumenize/lumenize-base';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';

/**
 * RemoteDO - Target of remote calls
 * 
 * This DO receives calls from OriginDO and executes operations.
 */
export class RemoteDO extends LumenizeBase<Env> {
  #executedOperations: Array<{ method: string; args: any[] }> = [];

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

  // Test: Call remote method with continuation
  async callRemoteGetUserData(userId: string) {
    const remote = this.ctn<RemoteDO>().getUserData(userId);
    
    await this.svc.call(
      'REMOTE_DO',
      'remote-instance',
      remote,
      this.ctn().handleUserDataResult(remote),
      { originBinding: 'ORIGIN_DO' }
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
      { originBinding: 'ORIGIN_DO' }
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
      { originBinding: 'ORIGIN_DO' }
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
      { timeout, originBinding: 'ORIGIN_DO' }
    );
  }

  handleTimeoutResult(result: any) {
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

  waitForResults(count: number, maxWait = 2000): Promise<void> {
    const startTime = Date.now();
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

