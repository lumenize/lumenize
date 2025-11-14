import { LumenizeBase } from '@lumenize/lumenize-base';
import '@lumenize/call';  // Auto-registers call service via NADIS
import { enableAlarmSimulation } from '@lumenize/testing';
import type { Unprotected } from '@lumenize/core';

export interface Env {
  ORIGIN_DO: DurableObjectNamespace<OriginDO>;
  REMOTE_DO: DurableObjectNamespace<RemoteDO>;
}

/**
 * RemoteDO - Receives and executes operations
 */
export class RemoteDO extends LumenizeBase<Env> {
  #executedOperations: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Enable alarm simulation for call's 0-second alarms
    enableAlarmSimulation(this, { timeScale: 100 });
  }

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
  #results: Array<{ type: 'success' | 'error'; value: any; userId?: string }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Enable alarm simulation for call's 0-second alarms
    enableAlarmSimulation(this, { timeScale: 100 });
  }

  // Example: Basic remote call (3-line extracted format - RECOMMENDED)
  async exampleBasicCall(userId: string) {
    const userData = this.ctn<RemoteDO>().getUserData(userId);  // Remote operation
    const handlerCtn = this.ctn().handleUserDataResult(userData, userId);  // Local handler with extra context
    this.svc.call('REMOTE_DO', 'remote-1', userData, handlerCtn);
  }

  // Example: Inline with variable reference (alternative syntax)
  async exampleBasicCall2(userId: string) {
    const userData = this.ctn<RemoteDO>().getUserData(userId);
    this.svc.call(
      'REMOTE_DO',
      'remote-1',
      userData,
      this.ctn().handleUserDataResult(userData, userId)  // Handlers can accept multiple params
    );
  }

  // Example: Inline with $result marker (alternative syntax)
  async exampleBasicCall3(userId: string) {
    this.svc.call(
      'REMOTE_DO',
      'remote-1',
      this.ctn<RemoteDO>().getUserData(userId),
      // @ts-expect-error - $result is a special marker added by the continuation proxy
      this.ctn().handleUserDataResult(this.ctn().$result, userId)  // Pass additional context
    );
  }

  // Example: Calling a method that throws
  async exampleErrorHandling(message: string) {
    const errorOp = this.ctn<RemoteDO>().throwError(message);
    const handlerCtn = this.ctn().handleUserDataResult(errorOp, 'error-user');
    this.svc.call('REMOTE_DO', 'remote-1', errorOp, handlerCtn);
  }

  // Example: Using timeout option
  async exampleWithTimeout(delayMs: number, timeoutMs: number) {
    const slowOp = this.ctn<RemoteDO>().slowOperation(delayMs);
    const handlerCtn = this.ctn().handleUserDataResult(slowOp, 'timeout-user');
    this.svc.call('REMOTE_DO', 'remote-1', slowOp, handlerCtn, { timeout: timeoutMs });
  }

  // Example: Math operation with typed handler
  async exampleMathOperation(a: number, b: number) {
    const mathOp = this.ctn<RemoteDO>().add(a, b);
    const handlerCtn = this.ctn().handleMathResult(mathOp);
    this.svc.call('REMOTE_DO', 'remote-1', mathOp, handlerCtn);
  }

  // Example: Nested operations execute in one round trip
  async exampleNestedOperations() {
    const op1 = this.ctn<RemoteDO>().add(1, 10);
    const op2 = this.ctn<RemoteDO>().add(100, 1000);
    const finalOp = this.ctn<RemoteDO>().add(op1, op2);
    const handlerCtn = this.ctn().handleMathResult(finalOp);
    this.svc.call('REMOTE_DO', 'remote-1', finalOp, handlerCtn);
  }

  // Example: Direct storage access in BOTH remote operation AND handler
  async exampleStorageAccessDirect(remoteInstanceId: string) {
    // Fetch storage value from remote DO
    // Unprotected prevents typescript from complaining but you know ctx is protected
    const remoteStorageOp = this.ctn<Unprotected<RemoteDO>>().ctx.storage.kv.get('__lmz_do_instance_name');
    // Store it directly via property chain (no handler method!)
    const handlerCtn = this.ctn().ctx.storage.kv.put('__lmz_fetched_remote_name_direct', remoteStorageOp);
    this.svc.call('REMOTE_DO', remoteInstanceId, remoteStorageOp, handlerCtn);
  }

  // Continuation handlers - called when results arrive

  handleUserDataResult(result: any, userId: string) {
    // Handlers can accept multiple parameters - not just the result!
    if (result instanceof Error) {
      this.#results.push({ type: 'error', value: result.message, userId });
    } else {
      this.#results.push({ type: 'success', value: result, userId });
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

  getFetchedRemoteName() {
    return this.ctx.storage.kv.get('__lmz_fetched_remote_name');
  }

  getFetchedRemoteNameDirect() {
    return this.ctx.storage.kv.get('__lmz_fetched_remote_name_direct');
  }

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
}

