import { LumenizeBase } from '@lumenize/lumenize-base';
import '@lumenize/call';  // Auto-registers call service via NADIS
import { enableAlarmSimulation } from '@lumenize/testing';

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
  #results: Array<{ type: 'success' | 'error'; value: any }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Enable alarm simulation for call's 0-second alarms
    enableAlarmSimulation(this, { timeScale: 100 });
  }

  // Example: Basic remote call (3-line extracted format - RECOMMENDED)
  async exampleBasicCall(userId: string) {
    const userData = this.ctn<RemoteDO>().getUserData(userId);  // Remote operation
    const handlerCtn = this.ctn().handleUserDataResult(userData);  // Local handler
    this.svc.call('REMOTE_DO', 'remote-1', userData, handlerCtn);
  }

  // Example: Inline with variable reference (alternative syntax)
  async exampleBasicCall2(userId: string) {
    const userData = this.ctn<RemoteDO>().getUserData(userId);
    this.svc.call(
      'REMOTE_DO',
      'remote-1',
      userData,
      this.ctn().handleUserDataResult(userData)
    );
  }

  // Example: Inline with $result marker (alternative syntax)
  async exampleBasicCall3(userId: string) {
    this.svc.call(
      'REMOTE_DO',
      'remote-1',
      this.ctn<RemoteDO>().getUserData(userId),
      // @ts-expect-error - $result is a special marker added by the continuation proxy
      this.ctn().handleUserDataResult(this.ctn().$result)
    );
  }

  // Example: Calling a method that throws
  async exampleErrorHandling(message: string) {
    const errorOp = this.ctn<RemoteDO>().throwError(message);
    const handlerCtn = this.ctn().handleUserDataResult(errorOp);
    this.svc.call('REMOTE_DO', 'remote-1', errorOp, handlerCtn);
  }

  // Example: Using timeout option
  async exampleWithTimeout(delayMs: number, timeoutMs: number) {
    const slowOp = this.ctn<RemoteDO>().slowOperation(delayMs);
    const handlerCtn = this.ctn().handleUserDataResult(slowOp);
    this.svc.call('REMOTE_DO', 'remote-1', slowOp, handlerCtn, { timeout: timeoutMs });
  }

  // Example: Math operation with typed handler
  async exampleMathOperation(a: number, b: number) {
    const mathOp = this.ctn<RemoteDO>().add(a, b);
    const handlerCtn = this.ctn().handleMathResult(mathOp);
    this.svc.call('REMOTE_DO', 'remote-1', mathOp, handlerCtn);
  }

  // Example: Direct storage access on remote DO
  async exampleStorageAccess(remoteInstanceId: string) {
    // Fetch storage value from remote DO
    const remoteStorageOp = this.ctn<RemoteDO>().ctx.storage.kv.get('__lmz_do_instance_name');
    const handlerCtn = this.ctn().handleRemoteStorageValue(remoteStorageOp);
    this.svc.call('REMOTE_DO', remoteInstanceId, remoteStorageOp, handlerCtn);
  }

  // Example: Direct storage access in BOTH remote operation AND handler
  async exampleStorageAccessDirect(remoteInstanceId: string) {
    // Fetch storage value from remote DO
    const remoteStorageOp = this.ctn<RemoteDO>().ctx.storage.kv.get('__lmz_do_instance_name');
    // Store it directly via property chain (no handler method!)
    const handlerCtn = this.ctn().ctx.storage.kv.put('__lmz_fetched_remote_name_direct', remoteStorageOp);
    this.svc.call('REMOTE_DO', remoteInstanceId, remoteStorageOp, handlerCtn);
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

  handleRemoteStorageValue(value: any) {
    if (value instanceof Error) {
      this.#results.push({ type: 'error', value: value.message });
    } else {
      // Store the remote's instance name locally under a different key
      this.ctx.storage.kv.put('__lmz_fetched_remote_name', value);
      this.#results.push({ type: 'success', value });
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

